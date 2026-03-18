import { randomBytes } from 'crypto';
import prisma from '../../lib/prisma.js';
import { decrypt } from '../../lib/crypto.js';
import { getRedis } from '../../lib/redis.js';
import { AppError } from '../../plugins/error.js';
import { mailService } from '../mail/mail.service.js';
import type { MailboxLoginInput } from './mailbox.schema.js';

interface MailboxSession {
    emailId: number;
    email: string;
    createdAt: string;
}

type MailFetchPayload = Awaited<ReturnType<typeof mailService.getEmails>>;

interface CachedMailboxFetch {
    fetchedAt: number;
    payload: MailFetchPayload;
}

const MAILBOX_SESSION_TTL_SECONDS = 60 * 60 * 12;
const MAILBOX_REFRESH_CACHE_TTL_SECONDS = 60;
const MAILBOX_REFRESH_COOLDOWN_MS = 10_000;

const localSessionStore = new Map<string, { value: MailboxSession; expiresAt: number }>();
const localMailboxCache = new Map<string, { value: CachedMailboxFetch; expiresAt: number }>();

export const MAILBOX_SESSION_COOKIE_NAME = 'mailbox_session';
export const MAILBOX_SESSION_MAX_AGE_SECONDS = MAILBOX_SESSION_TTL_SECONDS;

function buildSessionKey(token: string): string {
    return `mailbox:session:${token}`;
}

function buildMailboxCacheKey(emailId: number, mailbox: string): string {
    return `mailbox:messages:${emailId}:${mailbox.toUpperCase()}`;
}

function getLocalValue<T>(store: Map<string, { value: T; expiresAt: number }>, key: string): T | null {
    const current = store.get(key);
    if (!current) {
        return null;
    }
    if (Date.now() >= current.expiresAt) {
        store.delete(key);
        return null;
    }
    return current.value;
}

function setLocalValue<T>(store: Map<string, { value: T; expiresAt: number }>, key: string, value: T, ttlSeconds: number): void {
    store.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
    });
}

function deleteLocalValue<T>(store: Map<string, { value: T; expiresAt: number }>, key: string): void {
    store.delete(key);
}

async function getRedisJson<T>(key: string): Promise<T | null> {
    const redis = getRedis();
    if (!redis) {
        return null;
    }

    try {
        const raw = await redis.get(key);
        return raw ? JSON.parse(raw) as T : null;
    } catch {
        return null;
    }
}

async function setRedisJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const redis = getRedis();
    if (!redis) {
        return;
    }

    try {
        await redis.setex(key, ttlSeconds, JSON.stringify(value));
    } catch {
        // Fall back to local memory only.
    }
}

async function deleteRedisKey(key: string): Promise<void> {
    const redis = getRedis();
    if (!redis) {
        return;
    }

    try {
        await redis.del(key);
    } catch {
        // Fall back to local memory only.
    }
}

async function getStoredSession(token: string): Promise<MailboxSession | null> {
    const redisValue = await getRedisJson<MailboxSession>(buildSessionKey(token));
    if (redisValue) {
        return redisValue;
    }
    return getLocalValue(localSessionStore, token);
}

async function setStoredSession(token: string, session: MailboxSession): Promise<void> {
    setLocalValue(localSessionStore, token, session, MAILBOX_SESSION_TTL_SECONDS);
    await setRedisJson(buildSessionKey(token), session, MAILBOX_SESSION_TTL_SECONDS);
}

async function deleteStoredSession(token: string): Promise<void> {
    deleteLocalValue(localSessionStore, token);
    await deleteRedisKey(buildSessionKey(token));
}

async function getCachedMailboxFetch(emailId: number, mailbox: string): Promise<CachedMailboxFetch | null> {
    const cacheKey = buildMailboxCacheKey(emailId, mailbox);
    const redisValue = await getRedisJson<CachedMailboxFetch>(cacheKey);
    if (redisValue) {
        return redisValue;
    }
    return getLocalValue(localMailboxCache, cacheKey);
}

async function setCachedMailboxFetch(emailId: number, mailbox: string, value: CachedMailboxFetch): Promise<void> {
    const cacheKey = buildMailboxCacheKey(emailId, mailbox);
    setLocalValue(localMailboxCache, cacheKey, value, MAILBOX_REFRESH_CACHE_TTL_SECONDS);
    await setRedisJson(cacheKey, value, MAILBOX_REFRESH_CACHE_TTL_SECONDS);
}

function buildMailboxResponse(cached: CachedMailboxFetch, fromCache: boolean) {
    const ageMs = Date.now() - cached.fetchedAt;
    const cooldownRemainingMs = Math.max(0, MAILBOX_REFRESH_COOLDOWN_MS - ageMs);

    return {
        ...cached.payload,
        refreshedAt: new Date(cached.fetchedAt).toISOString(),
        fromCache,
        cooldownRemainingSeconds: Math.ceil(cooldownRemainingMs / 1000),
    };
}

async function getCurrentMailboxAccount(emailId: number) {
    const account = await prisma.emailAccount.findUnique({
        where: { id: emailId },
        select: {
            id: true,
            email: true,
            password: true,
            clientId: true,
            refreshToken: true,
            status: true,
            group: {
                select: {
                    fetchStrategy: true,
                },
            },
        },
    });

    if (!account || account.status === 'DISABLED') {
        throw new AppError('MAILBOX_SESSION_INVALID', 'Mailbox session is invalid', 401);
    }

    return account;
}

export const mailboxService = {
    async login(input: MailboxLoginInput) {
        const normalizedEmail = input.email.trim().toLowerCase();
        const account = await prisma.emailAccount.findFirst({
            where: {
                email: {
                    equals: normalizedEmail,
                    mode: 'insensitive',
                },
            },
            select: {
                id: true,
                email: true,
                password: true,
                status: true,
            },
        });

        if (!account || !account.password || account.status === 'DISABLED') {
            throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
        }

        let decryptedPassword = '';
        try {
            decryptedPassword = decrypt(account.password);
        } catch {
            throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
        }

        if (decryptedPassword !== input.password) {
            throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
        }

        const token = randomBytes(32).toString('base64url');
        const session: MailboxSession = {
            emailId: account.id,
            email: account.email,
            createdAt: new Date().toISOString(),
        };

        await setStoredSession(token, session);

        return {
            token,
            email: account.email,
        };
    },

    async requireSession(token: string | null | undefined): Promise<MailboxSession> {
        if (!token) {
            throw new AppError('MAILBOX_AUTH_REQUIRED', 'Mailbox login required', 401);
        }

        const session = await getStoredSession(token);
        if (!session) {
            throw new AppError('MAILBOX_SESSION_INVALID', 'Mailbox session is invalid', 401);
        }

        return session;
    },

    async logout(token: string | null | undefined): Promise<void> {
        if (!token) {
            return;
        }
        await deleteStoredSession(token);
    },

    async getCurrentUser(session: MailboxSession) {
        const account = await getCurrentMailboxAccount(session.emailId);
        return {
            email: account.email,
        };
    },

    async getMessages(session: MailboxSession, mailbox: 'INBOX' | 'JUNK') {
        const account = await getCurrentMailboxAccount(session.emailId);
        const cached = await getCachedMailboxFetch(account.id, mailbox);

        if (cached && Date.now() - cached.fetchedAt < MAILBOX_REFRESH_COOLDOWN_MS) {
            return buildMailboxResponse(cached, true);
        }

        const payload = await mailService.getEmails(
            {
                id: account.id,
                email: account.email,
                clientId: account.clientId,
                refreshToken: decrypt(account.refreshToken),
                autoAssigned: false,
                fetchStrategy: account.group?.fetchStrategy,
            },
            {
                mailbox,
                limit: 100,
            }
        );

        const nextCache: CachedMailboxFetch = {
            fetchedAt: Date.now(),
            payload,
        };

        await setCachedMailboxFetch(account.id, mailbox, nextCache);
        return buildMailboxResponse(nextCache, false);
    },
};
