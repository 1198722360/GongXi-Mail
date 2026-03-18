import { type FastifyPluginAsync } from 'fastify';
import { mailboxService, MAILBOX_SESSION_COOKIE_NAME, MAILBOX_SESSION_MAX_AGE_SECONDS } from './mailbox.service.js';
import { mailboxLoginSchema, mailboxMessagesQuerySchema } from './mailbox.schema.js';

function getMailboxSessionToken(request: { cookies?: Record<string, string | undefined> }): string | null {
    const token = request.cookies?.[MAILBOX_SESSION_COOKIE_NAME];
    return typeof token === 'string' && token.trim() ? token : null;
}

const mailboxRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post('/login', async (request, reply) => {
        const input = mailboxLoginSchema.parse(request.body);
        const result = await mailboxService.login(input);

        reply.cookie(MAILBOX_SESSION_COOKIE_NAME, result.token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
            maxAge: MAILBOX_SESSION_MAX_AGE_SECONDS,
        });

        return {
            success: true,
            data: {
                email: result.email,
            },
        };
    });

    fastify.post('/logout', async (request, reply) => {
        await mailboxService.logout(getMailboxSessionToken(request));
        reply.clearCookie(MAILBOX_SESSION_COOKIE_NAME, {
            path: '/',
        });

        return {
            success: true,
            data: {
                success: true,
            },
        };
    });

    fastify.get('/me', async (request) => {
        const session = await mailboxService.requireSession(getMailboxSessionToken(request));
        const currentUser = await mailboxService.getCurrentUser(session);
        return {
            success: true,
            data: currentUser,
        };
    });

    fastify.get('/messages', async (request) => {
        const session = await mailboxService.requireSession(getMailboxSessionToken(request));
        const query = mailboxMessagesQuerySchema.parse(request.query);
        const result = await mailboxService.getMessages(session, query.mailbox);

        return {
            success: true,
            data: result,
        };
    });
};

export default mailboxRoutes;
