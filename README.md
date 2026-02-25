# Figma MCP Server

A Model Context Protocol (MCP) server that provides integration with Figma's API through Claude and other MCP-compatible clients. Currently supports read-only access to Figma files and projects, with server-side architecture capable of supporting more advanced design token and theme management features (pending Figma API enhancements or plugin development).

## Project Status

### Current Progress

- ✅ **Core Implementation**: Successfully built a TypeScript server following the Model Context Protocol (MCP)
- ✅ **Claude Desktop Integration**: Tested and functional with Claude Desktop
- ✅ **Read Operations**: Working `get-file` and `list-files` tools for Figma file access
- ✅ **Server Architecture**: Caching system, error handling, and stats monitoring implemented
- ✅ **Transport Protocols**: Both stdio and SSE transport mechanisms supported

### Potential Full Functionality

The server has been designed with code to support these features (currently limited by API restrictions):

- **Variable Management**: Create, read, update, and delete design tokens (variables)
- **Reference Handling**: Create and validate relationships between tokens
- **Theme Management**: Create themes with multiple modes (e.g., light/dark)
- **Dependency Analysis**: Detect and prevent circular references
- **Batch Operations**: Perform bulk actions on variables and themes

With Figma plugin development or expanded API access, these features could be fully enabled.

## Features

- 🔑 Secure authentication with Figma API
- 📁 File operations (read, list)
- 🎨 Design system management
  - Variable creation and management
  - Theme creation and configuration
  - Reference handling and validation
- 🚀 Performance optimized
  - LRU caching
  - Rate limit handling
  - Connection pooling
- 📊 Comprehensive monitoring
  - Health checks
  - Usage statistics
  - Error tracking

## Prerequisites

- Node.js 18.x or higher
- Figma access token with appropriate permissions
- Basic understanding of MCP (Model Context Protocol)

## Installation

```bash
npm install figma-mcp-server
```

## Configuration

1. Create a `.env` file based on `.env.example`:

```env
# Figma API Access Token
FIGMA_ACCESS_TOKEN=your_figma_token

# Server Configuration
MCP_SERVER_PORT=3000

# Debug Configuration
DEBUG=figma-mcp:*
```

2. For Claude Desktop integration:

The server can be configured in your Claude Desktop config file:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "figma": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/figma-mcp-server/dist/index.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "your_token_here"
      }
    }
  }
}
```

**Important Notes:**
- Use ABSOLUTE paths, not relative paths
- On Windows, use double backslashes (\\\\) in paths
- Restart Claude Desktop after making configuration changes

## Usage

### Basic Usage

```javascript
import { startServer } from 'figma-mcp-server';

const server = await startServer(process.env.FIGMA_ACCESS_TOKEN);
```

### Available Tools

1. **get-file**
   - Retrieve Figma file details
   ```javascript
   {
     "name": "get-file",
     "arguments": {
       "fileKey": "your_file_key"
     }
   }
   ```

2. **list-files**
   - List files in a Figma project
   ```javascript
   {
     "name": "list-files",
     "arguments": {
       "projectId": "your_project_id"
     }
   }
   ```

3. **create-variables**
   - Create design system variables
   ```javascript
   {
     "name": "create-variables",
     "arguments": {
       "fileKey": "your_file_key",
       "variables": [
         {
           "name": "primary-color",
           "type": "COLOR",
           "value": "#0066FF"
         }
       ]
     }
   }
   ```

4. **create-theme**
   - Create and configure themes
   ```javascript
   {
     "name": "create-theme",
     "arguments": {
       "fileKey": "your_file_key",
       "name": "Dark Theme",
       "modes": [
         {
           "name": "dark",
           "variables": [
             {
               "variableId": "123",
               "value": "#000000"
             }
           ]
         }
       ]
     }
   }
   ```

## Running with Docker

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) 20.10+
- A valid Figma access token (see [Configuration](#configuration))

### Transport modes

| Mode | Flag | Use case |
|------|------|----------|
| **HTTP/SSE** (default) | _(none)_ | Kubernetes, Docker, any networked deployment |
| **stdio** | `--stdio` | Local Claude Desktop integration |

The default mode starts an Express HTTP server on port **3000** with three endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/sse` | `GET` | Establishes an MCP session over Server-Sent Events |
| `/messages?sessionId=<id>` | `POST` | Sends JSON-RPC requests for an active session |
| `/health` | `GET` | Health check (K8s liveness/readiness probe) |

### Build the image

The Dockerfile uses a two-stage build:
1. **Build stage** – installs all dependencies and compiles TypeScript.
2. **Runtime stage** – production dependencies only, compiled output, and a non-root user (`appuser`).

**For local use only** (builds for your machine's native architecture):

```bash
docker build -t figma-mcp-server:latest .
```

**For Kubernetes / ECR / any Linux amd64 cluster** (required when building on Apple Silicon):

```bash
docker buildx build --platform linux/amd64 -t figma-mcp-server:latest .
```

**For a multi-arch image** (runs on both amd64 clusters and Apple Silicon locally):

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t <your-ecr-registry>/figma-mcp-server:$(git rev-parse --short HEAD) \
  --push .
```

> If `docker buildx` reports no builder with multi-platform support, create one first:
> ```bash
> docker buildx create --use --name multiarch
> ```

### Run the container (HTTP/SSE mode)

```bash
docker run --rm -p 3000:3000 \
  -e FIGMA_ACCESS_TOKEN=your_token_here \
  figma-mcp-server:latest
```

Verify the server is healthy:

```bash
curl http://localhost:3000/health
```

### Run the container (stdio mode — Claude Desktop)

```bash
docker run --rm -i \
  -e FIGMA_ACCESS_TOKEN=your_token_here \
  figma-mcp-server:latest node server.js --stdio
```

> `-i` keeps stdin open for stdio-based MCP communication.

### Local development with Docker Compose

```bash
# Export your token into the shell first
export FIGMA_ACCESS_TOKEN=your_token_here

# Build and start (serves HTTP/SSE on http://localhost:3000)
docker compose up --build

# Tear down
docker compose down
```

Alternatively, create a local `.env` file (already in `.gitignore`) and uncomment the `env_file` block in `docker-compose.yml`.

### Kubernetes + Kong ingress

Kubernetes manifests (Deployment, Service, Secret, etc.) are handled in a separate PR. Key points for operators:

- **Sticky sessions are required.** Each `/sse` connection is stateful — the matching `POST /messages` calls must reach the same pod. Configure Kong with `hash_on: cookie` upstream or the `session` plugin.
- **Increase `proxy_read_timeout`** on the Kong route to at least `3600` seconds to keep SSE connections alive.
- **Health check:** use `GET /health` (returns HTTP 200 when healthy, 503 when not) for both liveness and readiness probes.
- **Secret injection:** set `FIGMA_ACCESS_TOKEN` via a Kubernetes Secret mounted as an environment variable.
- **Single replica** avoids the sticky-session requirement entirely — a valid choice for low-traffic internal tooling.

---

## API Documentation

### Server Methods

- `startServer(figmaToken: string, debug?: boolean, port?: number)`
  - Initializes and starts the MCP server
  - Returns: Promise<MCPServer>

### Tool Schemas

All tool inputs are validated using Zod schemas:

```typescript
const CreateVariablesSchema = z.object({
  fileKey: z.string(),
  variables: z.array(z.object({
    name: z.string(),
    type: z.enum(['COLOR', 'FLOAT', 'STRING']),
    value: z.string(),
    scope: z.enum(['LOCAL', 'ALL_FRAMES'])
  }))
});
```

## Error Handling

The server provides detailed error messages and proper error codes:

- Invalid token: 403 with specific error message
- Rate limiting: 429 with reset time
- Validation errors: 400 with field-specific details
- Server errors: 500 with error tracking

## Limitations & Known Issues

### API Restrictions

1. **Read-Only Operations**
   - Limited to read-only operations due to Figma API restrictions
   - Personal access tokens only support read operations, not write
   - Cannot modify variables, components, or styles through REST API with personal tokens
   - Write operations would require Figma plugin development instead

2. **Rate Limiting**
   - Follows Figma API rate limits
   - Implement exponential backoff for better handling

3. **Cache Management**
   - Default 5-minute TTL
   - Limited to 500 entries
   - Consider implementing cache invalidation hooks

4. **Authentication**
   - Only supports personal access tokens
   - No support for team-level permissions or collaborative editing
   - OAuth implementation planned for future

5. **Technical Implementation**
   - Requires absolute paths in configuration
   - Must compile TypeScript files before execution
   - Requires handling both local and global module resolution

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Submit a pull request

Please follow our coding standards:
- TypeScript strict mode
- ESLint configuration
- Jest for testing
- Comprehensive error handling

## License

MIT License - See LICENSE file for details

## Troubleshooting

See [TROUBLESHOOTING.md](examples/TROUBLESHOOTING.md) for a comprehensive troubleshooting guide.

### Common Issues

1. **JSON Connection Errors**
   - Use absolute paths in Claude Desktop configuration
   - Ensure the server is built (`npm run build`)
   - Verify all environment variables are set

2. **Authentication Issues**
   - Verify your Figma access token is valid
   - Check the token has required permissions
   - Ensure the token is correctly set in configuration

3. **Server Not Starting**
   - Check Node.js version (18.x+ required)
   - Verify the build exists (`dist/index.js`)
   - Check Claude Desktop logs:
     - macOS: `~/Library/Logs/Claude/mcp*.log`
     - Windows: `%APPDATA%\Claude\logs\mcp*.log`

For more detailed debugging steps and solutions, refer to the troubleshooting guide.

## Support

- GitHub Issues: [Report a bug](https://github.com/your-repo/issues)
- Documentation: [Wiki](https://github.com/your-repo/wiki)
- Discord: [Join our community](https://discord.gg/your-server)