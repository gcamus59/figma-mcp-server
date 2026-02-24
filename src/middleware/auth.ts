import { InvalidFigmaTokenError, InvalidUriError } from '../errors.js';

export class AuthMiddleware {
    constructor(private figmaToken: string) {}

    async validateToken(): Promise<void> {
        if (!this.figmaToken) {
            throw new InvalidFigmaTokenError('No Figma token provided');
        }

        let response: Response;
        try {
            response = await fetch('https://api.figma.com/v1/me', {
                headers: {
                    'X-Figma-Token': this.figmaToken
                }
            });
        } catch (networkError) {
            throw new InvalidFigmaTokenError(
                `Failed to reach Figma API for token validation: ${networkError instanceof Error ? networkError.message : String(networkError)}`
            );
        }

        if (!response.ok) {
            throw new InvalidFigmaTokenError(
                `Figma token validation failed (HTTP ${response.status}): token may be invalid or expired`
            );
        }
    }

    validateUri(uri: string): void {
        if (!uri.startsWith('figma:///')) {
            throw new InvalidUriError('Invalid Figma URI format');
        }
    }
}