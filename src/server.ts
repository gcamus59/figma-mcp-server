import { EventEmitter } from 'events';
import http from 'http';
import os from 'os';
import express, { Request, Response } from 'express';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FigmaHandler } from './handlers/figma.js';
import { AuthMiddleware } from './middleware/auth.js';
import { ServerState, ServerStats } from './types.js';
import { Logger } from './logger.js';

interface ConnectionStats {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    avgResponseTime: number;
    peakMemoryUsage: number;
}

interface FigmaApiStats {
    totalApiCalls: number;
    failedApiCalls: number;
    averageApiLatency: number;
    rateLimitRemaining: number | undefined | null;
    rateLimitReset: number | undefined | null;
    lastError?: {
        message: string;
        time: number;
        endpoint: string;
    };
}

export class MCPServer extends EventEmitter {
    private httpServer: http.Server | null = null;
    private healthCheckInterval: NodeJS.Timeout | null = null;
    private state: ServerState = 'starting';
    private startTime: number;
    private lastActivityTime: number;
    private connectionErrors: number = 0;
    private readonly defaultPort: number = 3000;
    private readonly debug: boolean;
    private port?: number;
    private figmaHandler: FigmaHandler;
    private readonly logger: Logger;

    // Active SSE sessions keyed by sessionId
    private sessions: Map<string, SSEServerTransport> = new Map();

    private connectionStats: ConnectionStats = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        avgResponseTime: 0,
        peakMemoryUsage: 0
    };

    private figmaApiStats: FigmaApiStats = {
        totalApiCalls: 0,
        failedApiCalls: 0,
        averageApiLatency: 0,
        rateLimitRemaining: undefined,
        rateLimitReset: undefined
    };

    constructor(
        private readonly figmaToken: string,
        debug = false,
        port?: number
    ) {
        super();
        this.debug = debug;
        this.port = port;
        this.startTime = Date.now();
        this.lastActivityTime = Date.now();
        this.logger = new Logger(debug);

        this.figmaHandler = new FigmaHandler(figmaToken, (stats) => {
            if (stats.totalApiCalls) {
                this.figmaApiStats.totalApiCalls += stats.totalApiCalls;
            }
            if (stats.failedApiCalls) {
                this.figmaApiStats.failedApiCalls += stats.failedApiCalls;
            }
            if (stats.apiResponseTimes) {
                const totalTime = stats.apiResponseTimes.reduce((a, b) => a + b, 0);
                this.figmaApiStats.averageApiLatency = totalTime / stats.apiResponseTimes.length;
            }
            if (stats.rateLimitRemaining !== undefined) {
                this.figmaApiStats.rateLimitRemaining = stats.rateLimitRemaining;
            }
            if (stats.rateLimitReset !== undefined) {
                this.figmaApiStats.rateLimitReset = stats.rateLimitReset;
            }
            if (stats.lastError) {
                this.figmaApiStats.lastError = stats.lastError;
            }
        });
    }

    /**
     * Creates a new MCP SDK Server instance with all request handlers registered.
     * Each SSE session requires its own Server instance because server.connect()
     * replaces the previous transport.
     */
    private createMcpSession(): Server {
        const server = new Server(
            { name: "figma-mcp-server", version: "1.0.0" },
            { capabilities: { tools: {} } }
        );

        server.onerror = (error: unknown) => {
            this.logger.error('MCP session error:', error);
            return {
                code: -32603,
                message: error instanceof Error ? error.message : 'Unknown server error',
                data: {
                    timestamp: Date.now(),
                    errorType: error instanceof Error ? error.constructor.name : typeof error
                }
            };
        };

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: await this.figmaHandler.listTools()
        }));

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const startTime = Date.now();
            this.connectionStats.totalRequests++;

            try {
                const result = await this.figmaHandler.callTool(
                    request.params.name,
                    request.params.arguments
                );

                this.connectionStats.successfulRequests++;
                const responseTime = Date.now() - startTime;
                this.connectionStats.avgResponseTime = (
                    this.connectionStats.avgResponseTime * (this.connectionStats.successfulRequests - 1) +
                    responseTime
                ) / this.connectionStats.successfulRequests;

                return result;
            } catch (error) {
                this.connectionStats.failedRequests++;
                throw error;
            } finally {
                const currentMemory = process.memoryUsage().heapUsed;
                if (currentMemory > this.connectionStats.peakMemoryUsage) {
                    this.connectionStats.peakMemoryUsage = currentMemory;
                }
                this.lastActivityTime = Date.now();
            }
        });

        return server;
    }

    private getHealthStatus() {
        const now = Date.now();
        return {
            state: this.state,
            uptime: Math.floor((now - this.startTime) / 1000),
            lastActivityTime: Math.floor((now - this.lastActivityTime) / 1000),
            connectionErrors: this.connectionErrors,
            isHealthy: this.state === 'running' && this.connectionErrors < 5,
            network: {
                localAddress: 'localhost',
                activePort: this.port || this.defaultPort,
                sseTransportEnabled: true,
                activeSessions: this.sessions.size
            },
            connections: this.connectionStats,
            figmaApi: this.figmaApiStats,
            system: {
                cpuUsage: process.cpuUsage().user / 1000000,
                memoryUsage: {
                    used: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024),
                    total: Math.floor(os.totalmem() / 1024 / 1024)
                }
            }
        };
    }

    private handleError(error: Error): void {
        this.connectionErrors++;
        this.logger.error('Server error:', error);
        this.emit('error', error);
    }

    private startHealthCheck(): void {
        this.healthCheckInterval = setInterval(() => {
            const health = this.getHealthStatus();

            if (this.debug || !health.isHealthy) {
                this.logger.log('Health Status:', health);
            }

            this.emit('healthUpdate', health);
        }, 10000);
    }

    public async start(): Promise<void> {
        const app = express();
        app.use(express.json());

        // Health check — used by K8s liveness/readiness probes
        app.get('/health', (_req: Request, res: Response) => {
            const health = this.getHealthStatus();
            res.status(health.isHealthy ? 200 : 503).json(health);
        });

        // SSE endpoint — each GET establishes a new MCP session
        app.get('/sse', async (req: Request, res: Response) => {
            this.logger.info('New SSE connection from', req.ip);
            const transport = new SSEServerTransport('/messages', res);
            const mcpServer = this.createMcpSession();

            this.sessions.set(transport.sessionId, transport);

            res.on('close', () => {
                this.logger.info('SSE connection closed, session:', transport.sessionId);
                this.sessions.delete(transport.sessionId);
            });

            try {
                await mcpServer.connect(transport);
                await transport.start();
            } catch (error) {
                this.sessions.delete(transport.sessionId);
                this.logger.error('SSE session error:', error);
                if (error instanceof Error) this.handleError(error);
            }
        });

        // Message endpoint — client POSTs JSON-RPC requests to this route
        app.post('/messages', async (req: Request, res: Response) => {
            const sessionId = req.query.sessionId as string;

            if (!sessionId) {
                res.status(400).json({ error: 'Missing sessionId query parameter' });
                return;
            }

            const transport = this.sessions.get(sessionId);
            if (!transport) {
                res.status(404).json({ error: `Session '${sessionId}' not found` });
                return;
            }

            try {
                await transport.handlePostMessage(req, res);
            } catch (error) {
                this.logger.error('Error handling POST message:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Internal server error' });
                }
            }
        });

        return new Promise((resolve, reject) => {
            const listenPort = this.port || this.defaultPort;

            this.httpServer = app.listen(listenPort, () => {
                this.state = 'running';
                this.startHealthCheck();

                const initHealth = this.getHealthStatus();
                this.logger.info('Server started', {
                    state: initHealth.state,
                    health: initHealth.isHealthy,
                    transport: 'sse',
                    port: listenPort,
                    protocol: 'MCP 1.0',
                    capabilities: ['tools'],
                    endpoints: {
                        sse: `http://localhost:${listenPort}/sse`,
                        messages: `http://localhost:${listenPort}/messages`,
                        health: `http://localhost:${listenPort}/health`
                    }
                });
                this.emit('healthUpdate', initHealth);
                resolve();
            });

            this.httpServer.on('error', (error: Error) => {
                this.state = 'error';
                this.logger.error('HTTP server error:', error);
                this.handleError(error);
                reject(error);
            });
        });
    }

    public async stop(): Promise<void> {
        this.state = 'stopping';

        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }

        // Close all active SSE sessions gracefully
        for (const [sessionId, transport] of this.sessions) {
            try {
                await transport.close();
            } catch (error) {
                this.logger.error(`Error closing session ${sessionId}:`, error);
            }
        }
        this.sessions.clear();

        await new Promise<void>((resolve) => {
            if (!this.httpServer) {
                resolve();
                return;
            }
            this.httpServer.close(() => {
                this.httpServer = null;
                resolve();
            });
        });

        this.state = 'stopped';

        const finalHealth = this.getHealthStatus();
        this.logger.info('Server stopped', {
            runtime: {
                uptime: finalHealth.uptime,
                requests: finalHealth.connections.totalRequests,
                successRate: (finalHealth.connections.successfulRequests /
                    Math.max(finalHealth.connections.totalRequests, 1) * 100).toFixed(2) + '%',
                errors: this.connectionErrors
            }
        });

        this.emit('healthUpdate', finalHealth);
    }
}

export const startServer = async (
    figmaToken: string,
    debug = false,
    port = 3000
): Promise<MCPServer> => {
    const logger = new Logger(debug);

    logger.info('Starting Figma MCP Server', {
        version: process.env.npm_package_version || '1.0.0',
        platform: `${os.platform()} (${os.release()})`,
        nodeVersion: process.version,
        config: { debug, port }
    });

    try {
        logger.info('Validating Figma access token...');
        const auth = new AuthMiddleware(figmaToken);
        await auth.validateToken();
        logger.info('Figma access token validated successfully');

        const server = new MCPServer(figmaToken, debug, port);
        await server.start();
        return server;
    } catch (error) {
        logger.error('Failed to start server:', error);
        throw error;
    }
};
