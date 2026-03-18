import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Form, Input, Button, Card, Typography, message, Spin } from 'antd';
import { MailOutlined, LockOutlined } from '@ant-design/icons';
import { mailboxApi } from '../../api';
import { getErrorMessage } from '../../utils/error';

const { Title, Text } = Typography;

interface MailLoginForm {
    email: string;
    password: string;
}

const MailLoginPage: React.FC = () => {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(false);
    const [checkingSession, setCheckingSession] = useState(true);

    useEffect(() => {
        let active = true;

        const checkSession = async () => {
            try {
                const response = await mailboxApi.me();
                if (!active) {
                    return;
                }
                if (response.code === 200) {
                    navigate('/mailbox', { replace: true });
                    return;
                }
            } catch {
                // Ignore and stay on login page.
            } finally {
                if (active) {
                    setCheckingSession(false);
                }
            }
        };

        void checkSession();
        return () => {
            active = false;
        };
    }, [navigate]);

    const handleSubmit = async (values: MailLoginForm) => {
        setLoading(true);
        try {
            const response = await mailboxApi.login(values.email, values.password);
            if (response.code === 200) {
                message.success('Login successful');
                navigate('/mailbox', { replace: true });
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, 'Login failed'));
        } finally {
            setLoading(false);
        }
    };

    if (checkingSession) {
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
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#f0f2f5',
            }}
        >
            <Card
                style={{
                    width: 380,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                }}
            >
                <div style={{ textAlign: 'center', marginBottom: 24 }}>
                    <Title level={3} style={{ margin: '0 0 8px 0' }}>
                        Mail Login
                    </Title>
                    <Text type="secondary">Use your mailbox account to view only your own emails.</Text>
                </div>

                <Form name="mail-login" onFinish={handleSubmit} size="large">
                    <Form.Item
                        name="email"
                        rules={[
                            { required: true, message: 'Please enter your email address' },
                            { type: 'email', message: 'Please enter a valid email address' },
                        ]}
                    >
                        <Input
                            prefix={<MailOutlined />}
                            placeholder="Email"
                        />
                    </Form.Item>

                    <Form.Item
                        name="password"
                        rules={[{ required: true, message: 'Please enter your password' }]}
                    >
                        <Input.Password
                            prefix={<LockOutlined />}
                            placeholder="Password"
                        />
                    </Form.Item>

                    <Form.Item style={{ marginBottom: 0 }}>
                        <Button
                            type="primary"
                            htmlType="submit"
                            loading={loading}
                            block
                        >
                            Sign In
                        </Button>
                    </Form.Item>
                </Form>
            </Card>
        </div>
    );
};

export default MailLoginPage;
