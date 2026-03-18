import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Empty, List, Modal, Space, Spin, Tabs, Typography, message } from 'antd';
import { LogoutOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { mailboxApi } from '../../api';
import { getErrorMessage } from '../../utils/error';

const { Title, Text } = Typography;

type MailboxName = 'INBOX' | 'JUNK';

interface MailItem {
    id: string;
    from: string;
    subject: string;
    text: string;
    html: string;
    date: string;
}

interface MailboxMessagesResult {
    email: string;
    mailbox: MailboxName;
    count: number;
    messages: MailItem[];
    method: string;
    refreshedAt: string;
    fromCache: boolean;
    cooldownRemainingSeconds: number;
}

function isUnauthorizedError(error: unknown): boolean {
    const code = String((error as { code?: unknown })?.code || '').toUpperCase();
    return code === 'MAILBOX_AUTH_REQUIRED' || code === 'MAILBOX_SESSION_INVALID' || code === 'UNAUTHORIZED';
}

const MailboxPage: React.FC = () => {
    const navigate = useNavigate();
    const [initializing, setInitializing] = useState(true);
    const [mailLoading, setMailLoading] = useState(false);
    const [email, setEmail] = useState('');
    const [currentMailbox, setCurrentMailbox] = useState<MailboxName>('INBOX');
    const [mailList, setMailList] = useState<MailItem[]>([]);
    const [cooldownRemainingSeconds, setCooldownRemainingSeconds] = useState(0);
    const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
    const [fetchMethod, setFetchMethod] = useState('');
    const [emailDetailVisible, setEmailDetailVisible] = useState(false);
    const [emailDetailContent, setEmailDetailContent] = useState('');
    const [emailDetailSubject, setEmailDetailSubject] = useState('');

    useEffect(() => {
        if (cooldownRemainingSeconds <= 0) {
            return;
        }

        const timer = window.setTimeout(() => {
            setCooldownRemainingSeconds((current) => Math.max(0, current - 1));
        }, 1000);

        return () => window.clearTimeout(timer);
    }, [cooldownRemainingSeconds]);

    const emailDetailSrcDoc = useMemo(
        () => `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                        font-size: 14px;
                        line-height: 1.6;
                        color: #333;
                        margin: 0;
                        padding: 16px;
                        background: #fafafa;
                    }
                    img { max-width: 100%; height: auto; }
                    a { color: #1890ff; }
                </style>
            </head>
            <body>${emailDetailContent}</body>
            </html>
        `,
        [emailDetailContent]
    );

    const redirectToLogin = useCallback(() => {
        navigate('/mail-login', { replace: true });
    }, [navigate]);

    const loadMessages = useCallback(async (mailbox: MailboxName, options?: { manual?: boolean }) => {
        setMailLoading(true);
        try {
            const response = await mailboxApi.getMessages(mailbox);
            if (response.code === 200) {
                const result = response.data as MailboxMessagesResult;
                setEmail(result.email);
                setMailList(result.messages || []);
                setCurrentMailbox(result.mailbox);
                setCooldownRemainingSeconds(result.cooldownRemainingSeconds || 0);
                setLastRefreshedAt(result.refreshedAt || null);
                setFetchMethod(result.method || '');

                if (options?.manual) {
                    if (result.fromCache && (result.cooldownRemainingSeconds || 0) > 0) {
                        message.info(`Refresh cooldown active. Showing cached result. Try again in ${result.cooldownRemainingSeconds}s.`);
                    } else {
                        message.success('Mailbox refreshed');
                    }
                }
            }
        } catch (err: unknown) {
            if (isUnauthorizedError(err)) {
                redirectToLogin();
                return;
            }
            message.error(getErrorMessage(err, 'Failed to load emails'));
        } finally {
            setMailLoading(false);
        }
    }, [redirectToLogin]);

    useEffect(() => {
        let active = true;

        const bootstrap = async () => {
            try {
                const response = await mailboxApi.me();
                if (!active) {
                    return;
                }
                if (response.code === 200) {
                    setEmail(response.data.email);
                    await loadMessages('INBOX');
                    return;
                }
                redirectToLogin();
            } catch (err: unknown) {
                if (!active) {
                    return;
                }
                if (isUnauthorizedError(err)) {
                    redirectToLogin();
                    return;
                }
                message.error(getErrorMessage(err, 'Failed to initialize mailbox'));
            } finally {
                if (active) {
                    setInitializing(false);
                }
            }
        };

        void bootstrap();
        return () => {
            active = false;
        };
    }, [loadMessages, redirectToLogin]);

    const handleLogout = async () => {
        try {
            await mailboxApi.logout();
        } catch {
            // Ignore logout errors and still clear client state by redirecting.
        } finally {
            navigate('/mail-login', { replace: true });
        }
    };

    const handleRefresh = async () => {
        await loadMessages(currentMailbox, { manual: true });
    };

    const handleMailboxChange = async (key: string) => {
        const nextMailbox = key as MailboxName;
        setCurrentMailbox(nextMailbox);
        await loadMessages(nextMailbox);
    };

    const handleViewEmailDetail = (record: MailItem) => {
        setEmailDetailSubject(record.subject || 'No subject');
        setEmailDetailContent(record.html || record.text || 'No content');
        setEmailDetailVisible(true);
    };

    if (initializing) {
        return (
            <div
                style={{
                    minHeight: '100vh',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: '#f0f2f5',
                }}
            >
                <Spin size="large" />
            </div>
        );
    }

    return (
        <div
            style={{
                minHeight: '100vh',
                background: '#f0f2f5',
                padding: 24,
            }}
        >
            <div style={{ maxWidth: 1080, margin: '0 auto' }}>
                <Card style={{ marginBottom: 16 }}>
                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'flex-start',
                            gap: 16,
                            flexWrap: 'wrap',
                        }}
                    >
                        <div>
                            <Title level={3} style={{ margin: 0 }}>
                                Mailbox
                            </Title>
                            <Text type="secondary">{email || 'Current mailbox'}</Text>
                            <div style={{ marginTop: 12 }}>
                                <Space wrap>
                                    <Text type="secondary">
                                        Last refresh: {lastRefreshedAt ? dayjs(lastRefreshedAt).format('YYYY-MM-DD HH:mm:ss') : '-'}
                                    </Text>
                                    <Text type="secondary">
                                        Method: {fetchMethod || '-'}
                                    </Text>
                                    <Text type="secondary">
                                        Cooldown: {cooldownRemainingSeconds}s
                                    </Text>
                                </Space>
                            </div>
                        </div>

                        <Space>
                            <Button
                                type="primary"
                                icon={<ReloadOutlined />}
                                onClick={() => void handleRefresh()}
                                loading={mailLoading}
                                disabled={cooldownRemainingSeconds > 0}
                            >
                                {cooldownRemainingSeconds > 0 ? `Refresh (${cooldownRemainingSeconds}s)` : 'Refresh'}
                            </Button>
                            <Button icon={<LogoutOutlined />} onClick={() => void handleLogout()}>
                                Logout
                            </Button>
                        </Space>
                    </div>
                </Card>

                <Card bodyStyle={{ paddingTop: 8 }}>
                    <Tabs
                        activeKey={currentMailbox}
                        onChange={(key) => void handleMailboxChange(key)}
                        items={[
                            { key: 'INBOX', label: 'Inbox' },
                            { key: 'JUNK', label: 'Junk' },
                        ]}
                    />

                    <List
                        loading={mailLoading}
                        dataSource={mailList}
                        itemLayout="horizontal"
                        locale={{
                            emptyText: <Empty description="No emails" image={Empty.PRESENTED_IMAGE_SIMPLE} />,
                        }}
                        pagination={{
                            pageSize: 10,
                            showSizeChanger: true,
                            showQuickJumper: true,
                            showTotal: (total: number) => `${total} emails`,
                            style: { marginTop: 16 },
                        }}
                        renderItem={(item: MailItem) => (
                            <List.Item
                                key={item.id}
                                actions={[
                                    <Button
                                        type="primary"
                                        size="small"
                                        onClick={() => handleViewEmailDetail(item)}
                                    >
                                        View
                                    </Button>,
                                ]}
                            >
                                <List.Item.Meta
                                    title={
                                        <Typography.Text ellipsis style={{ maxWidth: 680 }}>
                                            {item.subject || '(No subject)'}
                                        </Typography.Text>
                                    }
                                    description={
                                        <Space size="large" wrap>
                                            <span style={{ color: '#1890ff' }}>{item.from || 'Unknown sender'}</span>
                                            <span style={{ color: '#999' }}>
                                                {item.date ? dayjs(item.date).format('YYYY-MM-DD HH:mm') : '-'}
                                            </span>
                                        </Space>
                                    }
                                />
                            </List.Item>
                        )}
                    />
                </Card>
            </div>

            <Modal
                title={emailDetailSubject}
                open={emailDetailVisible}
                onCancel={() => setEmailDetailVisible(false)}
                footer={null}
                destroyOnClose
                width={900}
                styles={{ body: { padding: '16px 24px' } }}
            >
                <iframe
                    title="mailbox-email-content"
                    sandbox="allow-same-origin"
                    srcDoc={emailDetailSrcDoc}
                    style={{
                        width: '100%',
                        height: 'calc(100vh - 300px)',
                        border: '1px solid #eee',
                        borderRadius: 8,
                        backgroundColor: '#fafafa',
                    }}
                />
            </Modal>
        </div>
    );
};

export default MailboxPage;
