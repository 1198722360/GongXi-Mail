import { z } from 'zod';

export const mailboxLoginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});

export const mailboxMessagesQuerySchema = z.object({
    mailbox: z.preprocess(
        (value) => typeof value === 'string' ? value.toUpperCase() : value,
        z.enum(['INBOX', 'JUNK']).default('INBOX')
    ),
});

export type MailboxLoginInput = z.infer<typeof mailboxLoginSchema>;
export type MailboxMessagesQuery = z.infer<typeof mailboxMessagesQuerySchema>;
