import prisma from '../../lib/prisma.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { AppError } from '../../plugins/error.js';
import type { Prisma } from '@prisma/client';
import type { CreateEmailInput, UpdateEmailInput, ListEmailInput, ImportEmailInput } from './email.schema.js';

export interface EmailImportProgress {
    total: number;
    completed: number;
    success: number;
    failed: number;
    lastError?: string;
}

function formatImportLineError(line: string, error: unknown): string {
    return `Line "${line.substring(0, 30)}...": ${(error as Error).message}`;
}

function parseImportParts(line: string, separator: string) {
    const parts = line.trim().split(separator);
    if (parts.length < 3) {
        throw new Error('Invalid format');
    }

    let email: string | undefined;
    let clientId: string | undefined;
    let refreshToken: string | undefined;
    let password: string | undefined;

    if (parts.length >= 5) {
        email = parts[0];
        clientId = parts[1];
        refreshToken = parts[4];
    } else if (parts.length === 4) {
        email = parts[0];
        password = parts[1];
        clientId = parts[2];
        refreshToken = parts[3];
    } else {
        email = parts[0];
        clientId = parts[1];
        refreshToken = parts[2];
    }

    if (!email || !clientId || !refreshToken) {
        throw new Error('Missing required fields');
    }

    return { email, clientId, refreshToken, password };
}

async function ensureImportGroupExists(groupId?: number) {
    if (groupId === undefined) {
        return;
    }

    const group = await prisma.emailGroup.findUnique({ where: { id: groupId } });
    if (!group) {
        throw new AppError('GROUP_NOT_FOUND', 'Email group not found', 404);
    }
}

async function importEmailLine(line: string, separator = '----', groupId?: number) {
    const { email, clientId, refreshToken, password } = parseImportParts(line, separator);

    const data: Prisma.EmailAccountUncheckedUpdateInput = {
        clientId,
        refreshToken: encrypt(refreshToken),
        status: 'ACTIVE',
    };
    if (password) data.password = encrypt(password);
    if (groupId !== undefined) data.groupId = groupId;

    const exists = await prisma.emailAccount.findUnique({ where: { email } });
    if (exists) {
        await prisma.emailAccount.update({
            where: { email },
            data,
        });
        return;
    }

    const createData: Prisma.EmailAccountUncheckedCreateInput = {
        email,
        clientId,
        refreshToken: encrypt(refreshToken),
        status: 'ACTIVE',
    };
    if (password) {
        createData.password = encrypt(password);
    }
    if (groupId !== undefined) {
        createData.groupId = groupId;
    }
    await prisma.emailAccount.create({
        data: createData,
    });
}

export const emailService = {
    /**
     * 获取邮箱列表
     */
    async list(input: ListEmailInput) {
        const { page, pageSize, status, keyword, groupId, groupName } = input;
        const skip = (page - 1) * pageSize;

        const where: Prisma.EmailAccountWhereInput = {};
        if (status) where.status = status;
        if (keyword) {
            where.email = { contains: keyword };
        }
        if (groupId) {
            where.groupId = groupId;
        } else if (groupName) {
            where.group = { name: groupName };
        }

        const [list, total] = await Promise.all([
            prisma.emailAccount.findMany({
                where,
                select: {
                    id: true,
                    email: true,
                    clientId: true,
                status: true,
                groupId: true,
                group: { select: { id: true, name: true, fetchStrategy: true } },
                lastCheckAt: true,
                tokenRefreshedAt: true,
                errorMessage: true,
                createdAt: true,
            },
                skip,
                take: pageSize,
                orderBy: { id: 'desc' },
            }),
            prisma.emailAccount.count({ where }),
        ]);

        return { list, total, page, pageSize };
    },

    /**
     * 获取邮箱详情
     */
    async getById(id: number, includeSecrets = false) {
        const email = await prisma.emailAccount.findUnique({
            where: { id },
            select: {
                id: true,
                email: true,
                clientId: true,
                password: !!includeSecrets,
                refreshToken: !!includeSecrets,
                status: true,
                groupId: true,
                group: { select: { id: true, name: true, fetchStrategy: true } },
                lastCheckAt: true,
                tokenRefreshedAt: true,
                errorMessage: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        if (!email) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }

        // 解密敏感信息
        if (includeSecrets) {
            return {
                ...email,
                refreshToken: email.refreshToken ? decrypt(email.refreshToken) : email.refreshToken,
                password: email.password ? decrypt(email.password) : email.password,
            };
        }

        return email;
    },

    /**
     * 根据邮箱地址获取（用于外部 API）
     */
    async getByEmail(emailAddress: string) {
        const email = await prisma.emailAccount.findUnique({
            where: { email: emailAddress },
            select: {
                id: true,
                email: true,
                clientId: true,
                refreshToken: true,
                password: true,
                status: true,
                groupId: true,
                group: {
                    select: {
                        fetchStrategy: true,
                    },
                },
            },
        });

        if (!email) {
            return null;
        }

        // 解密
        return {
            ...email,
            refreshToken: decrypt(email.refreshToken),
            password: email.password ? decrypt(email.password) : undefined,
            fetchStrategy: email.group?.fetchStrategy || 'GRAPH_FIRST',
        };
    },

    /**
     * 创建邮箱账户
     */
    async create(input: CreateEmailInput) {
        const { email, clientId, refreshToken, password, groupId } = input;

        const exists = await prisma.emailAccount.findUnique({ where: { email } });
        if (exists) {
            throw new AppError('DUPLICATE_EMAIL', 'Email already exists', 400);
        }

        const encryptedToken = encrypt(refreshToken);
        const encryptedPassword = password ? encrypt(password) : null;

        const account = await prisma.emailAccount.create({
            data: {
                email,
                clientId,
                refreshToken: encryptedToken,
                password: encryptedPassword,
                groupId: groupId || null,
            },
            select: {
                id: true,
                email: true,
                clientId: true,
                status: true,
                groupId: true,
                createdAt: true,
            },
        });

        return account;
    },

    /**
     * 更新邮箱账户
     */
    async update(id: number, input: UpdateEmailInput) {
        const exists = await prisma.emailAccount.findUnique({ where: { id } });
        if (!exists) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }

        const { refreshToken, password, ...rest } = input;
        const updateData: Prisma.EmailAccountUpdateInput = { ...rest };

        // 加密 sensitive data
        if (refreshToken) {
            updateData.refreshToken = encrypt(refreshToken);
        }
        if (password) {
            updateData.password = encrypt(password);
        }

        const account = await prisma.emailAccount.update({
            where: { id },
            data: updateData,
            select: {
                id: true,
                email: true,
                clientId: true,
                status: true,
                updatedAt: true,
            },
        });

        return account;
    },

    /**
     * 更新邮箱状态
     */
    async updateStatus(id: number, status: 'ACTIVE' | 'ERROR' | 'DISABLED', errorMessage?: string | null) {
        await prisma.emailAccount.update({
            where: { id },
            data: {
                status,
                errorMessage: errorMessage || null,
                lastCheckAt: new Date(),
            },
        });
    },

    /**
     * 仅更新时间，不改动邮箱状态
     */
    async touchLastCheckAt(id: number) {
        await prisma.emailAccount.update({
            where: { id },
            data: {
                lastCheckAt: new Date(),
            },
        });
    },

    /**
     * 删除邮箱账户
     */
    async delete(id: number) {
        const exists = await prisma.emailAccount.findUnique({ where: { id } });
        if (!exists) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }

        await prisma.emailAccount.delete({ where: { id } });
        return { success: true };
    },

    /**
     * 批量删除
     */
    async batchDelete(ids: number[]) {
        await prisma.emailAccount.deleteMany({
            where: { id: { in: ids } },
        });
        return { deleted: ids.length };
    },

    /**
     * 批量导入
     */
    async ensureImportGroupExists(groupId?: number) {
        await ensureImportGroupExists(groupId);
    },

    async importLine(line: string, separator = '----', groupId?: number) {
        await importEmailLine(line, separator, groupId);
    },

    async import(input: ImportEmailInput, options?: { onProgress?: (progress: EmailImportProgress) => void }) {
        const { content, separator, groupId } = input;
        const lines = content.split(/\r?\n/).filter((line: string) => line.trim());

        await ensureImportGroupExists(groupId);

        let success = 0;
        let failed = 0;
        const errors: string[] = [];
        let completed = 0;

        for (const line of lines) {
            let lastError: string | undefined;
            try {
                await importEmailLine(line, separator, groupId);
                success++;
            } catch (err: unknown) {
                failed++;
                lastError = formatImportLineError(line, err);
                errors.push(lastError);
            }
            completed++;
            options?.onProgress?.({
                total: lines.length,
                completed,
                success,
                failed,
                lastError,
            });
        }

        return { total: lines.length, success, failed, errors };
    },

    /**
     * 导出
     */
    async export(ids?: number[], separator = '----', groupId?: number) {
        const where: Prisma.EmailAccountWhereInput = {};
        if (ids?.length) {
            where.id = { in: ids };
        }
        if (groupId !== undefined) {
            where.groupId = groupId;
        }

        const accounts = await prisma.emailAccount.findMany({
            where,
            select: {
                email: true,
                password: true,
                clientId: true,
                refreshToken: true,
            },
        });

        const lines = accounts.map((acc: { email: string; password: string | null; clientId: string; refreshToken: string }) => {
            const password = acc.password ? decrypt(acc.password) : '';
            const token = decrypt(acc.refreshToken);
            return `${acc.email}${separator}${password}${separator}${acc.clientId}${separator}${token}`;
        });

        return lines.join('\n');
    },

    /**
     * 获取统计
     */
    async getStats() {
        const [total, active, error] = await Promise.all([
            prisma.emailAccount.count(),
            prisma.emailAccount.count({ where: { status: 'ACTIVE' } }),
            prisma.emailAccount.count({ where: { status: 'ERROR' } }),
        ]);

        return { total, active, error };
    },
};
