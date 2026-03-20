import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { AppError } from '../../plugins/error.js';
import { logger } from '../../lib/logger.js';
import { emailService } from './email.service.js';
import type { ImportEmailInput } from './email.schema.js';

export type EmailImportJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface EmailImportJobSnapshot {
    id: string;
    status: EmailImportJobStatus;
    total: number;
    completed: number;
    success: number;
    failed: number;
    separator: string;
    groupId: number | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    durationMs: number;
    createdById: number | null;
    createdByUsername: string | null;
    recentErrors: string[];
    positionInQueue: number | null;
}

export interface EmailImportQueueStatus {
    isRunning: boolean;
    pendingCount: number;
    currentJob: EmailImportJobSnapshot | null;
    jobs: EmailImportJobSnapshot[];
}

interface EmailImportJobRecord extends Omit<EmailImportJobSnapshot, 'positionInQueue'> {
    filePath: string;
}

const IMPORT_QUEUE_DIR = join(tmpdir(), 'gongxi-mail', 'email-import-queue');
const JOB_HISTORY_LIMIT = 20;
const RECENT_ERROR_LIMIT = 10;

const jobs = new Map<string, EmailImportJobRecord>();
const queue: string[] = [];
let queueProcessing = false;
let currentJobId: string | null = null;
let queueDirPromise: Promise<string> | null = null;

function getQueueDir(): Promise<string> {
    if (!queueDirPromise) {
        queueDirPromise = mkdir(IMPORT_QUEUE_DIR, { recursive: true }).then(() => IMPORT_QUEUE_DIR);
    }
    return queueDirPromise;
}

function appendRecentError(target: string[], errorMessage: string) {
    target.push(errorMessage);
    if (target.length > RECENT_ERROR_LIMIT) {
        target.splice(0, target.length - RECENT_ERROR_LIMIT);
    }
}

function formatLineError(line: string, error: unknown): string {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return `Line "${line.substring(0, 30)}...": ${message}`;
}

function countNonEmptyLines(content: string): number {
    let count = 0;
    let hasNonWhitespace = false;

    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        if (char === '\r') {
            continue;
        }
        if (char === '\n') {
            if (hasNonWhitespace) {
                count += 1;
            }
            hasNonWhitespace = false;
            continue;
        }
        if (!hasNonWhitespace && char.trim() !== '') {
            hasNonWhitespace = true;
        }
    }

    if (hasNonWhitespace) {
        count += 1;
    }

    return count;
}

function getPositionInQueue(jobId: string, status: EmailImportJobStatus): number | null {
    if (status === 'RUNNING') {
        return 0;
    }
    if (status !== 'QUEUED') {
        return null;
    }

    const index = queue.indexOf(jobId);
    return index >= 0 ? index + 1 : null;
}

function toSnapshot(job: EmailImportJobRecord): EmailImportJobSnapshot {
    return {
        id: job.id,
        status: job.status,
        total: job.total,
        completed: job.completed,
        success: job.success,
        failed: job.failed,
        separator: job.separator,
        groupId: job.groupId,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        durationMs: job.durationMs,
        createdById: job.createdById,
        createdByUsername: job.createdByUsername,
        recentErrors: [...job.recentErrors],
        positionInQueue: getPositionInQueue(job.id, job.status),
    };
}

function cleanupFinishedJobs() {
    const finishedJobs = Array.from(jobs.values())
        .filter((job) => job.status === 'COMPLETED' || job.status === 'FAILED')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const removable = finishedJobs.slice(0, Math.max(0, finishedJobs.length - JOB_HISTORY_LIMIT));
    for (const job of removable) {
        jobs.delete(job.id);
    }
}

async function cleanupJobFile(filePath: string) {
    try {
        await unlink(filePath);
    } catch {
        // ignore missing temp files
    }
}

async function processJob(job: EmailImportJobRecord): Promise<void> {
    const startedAt = new Date();
    job.status = 'RUNNING';
    job.startedAt = startedAt;
    job.completedAt = null;
    job.durationMs = 0;
    currentJobId = job.id;

    logger.info({
        systemEvent: true,
        action: 'email.import_job_started',
        jobId: job.id,
        total: job.total,
        groupId: job.groupId,
        createdById: job.createdById,
        createdByUsername: job.createdByUsername,
    }, 'Email import job started');

    try {
        const reader = createInterface({
            input: createReadStream(job.filePath, { encoding: 'utf8' }),
            crlfDelay: Infinity,
        });

        for await (const rawLine of reader) {
            const line = rawLine.trim();
            if (!line) {
                continue;
            }

            try {
                await emailService.importLine(line, job.separator, job.groupId ?? undefined);
                job.success += 1;
            } catch (error: unknown) {
                job.failed += 1;
                appendRecentError(job.recentErrors, formatLineError(line, error));
            }

            job.completed += 1;
            job.durationMs = Date.now() - startedAt.getTime();
        }

        job.status = 'COMPLETED';
        job.completedAt = new Date();
        job.durationMs = job.completedAt.getTime() - startedAt.getTime();

        logger.info({
            systemEvent: true,
            action: 'email.import_job_completed',
            jobId: job.id,
            total: job.total,
            success: job.success,
            failed: job.failed,
            groupId: job.groupId,
            createdById: job.createdById,
            createdByUsername: job.createdByUsername,
            durationMs: job.durationMs,
        }, 'Email import job completed');
    } catch (error: unknown) {
        job.status = 'FAILED';
        job.completedAt = new Date();
        job.durationMs = job.completedAt.getTime() - startedAt.getTime();
        appendRecentError(job.recentErrors, error instanceof Error ? error.message : 'Unknown error');

        logger.error({
            err: error,
            systemEvent: true,
            action: 'email.import_job_failed',
            jobId: job.id,
            total: job.total,
            success: job.success,
            failed: job.failed,
            groupId: job.groupId,
            createdById: job.createdById,
            createdByUsername: job.createdByUsername,
            durationMs: job.durationMs,
        }, 'Email import job failed');
    } finally {
        currentJobId = null;
        await cleanupJobFile(job.filePath);
    }
}

async function processQueue(): Promise<void> {
    if (queueProcessing) {
        return;
    }

    queueProcessing = true;
    try {
        while (queue.length > 0) {
            const jobId = queue.shift();
            if (!jobId) {
                continue;
            }

            const job = jobs.get(jobId);
            if (!job) {
                continue;
            }

            await processJob(job);
            cleanupFinishedJobs();
        }
    } finally {
        queueProcessing = false;
        currentJobId = null;
    }
}

export const emailImportQueueService = {
    async enqueue(
        input: ImportEmailInput,
        requestedBy?: { id: number; username: string } | null
    ): Promise<EmailImportJobSnapshot> {
        const total = countNonEmptyLines(input.content);
        if (total === 0) {
            throw new AppError('EMPTY_IMPORT', 'Import content is empty', 400);
        }

        await emailService.ensureImportGroupExists(input.groupId);

        const queueDir = await getQueueDir();
        const jobId = randomUUID();
        const filePath = join(queueDir, `${jobId}.txt`);
        await writeFile(filePath, input.content, 'utf8');

        const job: EmailImportJobRecord = {
            id: jobId,
            status: 'QUEUED',
            total,
            completed: 0,
            success: 0,
            failed: 0,
            separator: input.separator || '----',
            groupId: input.groupId ?? null,
            createdAt: new Date(),
            startedAt: null,
            completedAt: null,
            durationMs: 0,
            createdById: requestedBy?.id ?? null,
            createdByUsername: requestedBy?.username ?? null,
            recentErrors: [],
            filePath,
        };

        jobs.set(jobId, job);
        queue.push(jobId);

        logger.info({
            systemEvent: true,
            action: 'email.import_job_enqueued',
            jobId,
            total,
            groupId: job.groupId,
            createdById: job.createdById,
            createdByUsername: job.createdByUsername,
            pendingCount: queue.length,
        }, 'Email import job enqueued');

        void processQueue();
        return toSnapshot(job);
    },

    getStatus(): EmailImportQueueStatus {
        const currentJob = currentJobId ? jobs.get(currentJobId) ?? null : null;
        const sortedJobs = Array.from(jobs.values()).sort((left, right) => {
            const leftRank = left.status === 'RUNNING' ? 0 : left.status === 'QUEUED' ? 1 : 2;
            const rightRank = right.status === 'RUNNING' ? 0 : right.status === 'QUEUED' ? 1 : 2;
            if (leftRank !== rightRank) {
                return leftRank - rightRank;
            }
            if (leftRank <= 1) {
                return left.createdAt.getTime() - right.createdAt.getTime();
            }
            const leftCompleted = left.completedAt?.getTime() || left.createdAt.getTime();
            const rightCompleted = right.completedAt?.getTime() || right.createdAt.getTime();
            return rightCompleted - leftCompleted;
        });

        return {
            isRunning: currentJob !== null,
            pendingCount: queue.length,
            currentJob: currentJob ? toSnapshot(currentJob) : null,
            jobs: sortedJobs.map((job) => toSnapshot(job)),
        };
    },
};
