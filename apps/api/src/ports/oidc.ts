import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { Clock } from '@heed/shared';

/**
 * Verifies the Google-signed OIDC identity token that Cloud Scheduler (or Cloud Tasks) attaches to
 * calls to `/internal/*` (docs/SECURITY.md T21). Validates: signature (Google JWKS), issuer, audience
 * (this service's URL), expiry (against the injected Clock), that the identity is exactly the
 * configured scheduler service account, and that its email is verified.
 */
export class OidcVerificationError extends Error {
  override readonly name = 'OidcVerificationError';

  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface OidcVerifier {
  /** Resolves on success; rejects with OidcVerificationError otherwise (never with token content). */
  verify(token: string): Promise<void>;
}

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export interface GoogleOidcVerifierOptions {
  readonly audience: string;
  readonly allowedServiceAccountEmail: string;
  readonly clock: Clock;
  /** Test seam. Defaults to Google's remote JWKS (cached per instance, an optimization only). */
  readonly keys?: JWTVerifyGetKey;
}

export class GoogleOidcVerifier implements OidcVerifier {
  readonly #options: GoogleOidcVerifierOptions;
  readonly #keys: JWTVerifyGetKey;

  constructor(options: GoogleOidcVerifierOptions) {
    this.#options = options;
    this.#keys = options.keys ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  }

  async verify(token: string): Promise<void> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.#keys, {
        issuer: [...GOOGLE_ISSUERS],
        audience: this.#options.audience,
        algorithms: ['RS256'],
        currentDate: this.#options.clock.now(),
      }));
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        throw new OidcVerificationError('expired');
      }
      if (error instanceof joseErrors.JWTClaimValidationFailed) {
        throw new OidcVerificationError(`claim:${error.claim}`);
      }
      throw new OidcVerificationError('invalid');
    }
    if (payload['email_verified'] !== true) {
      throw new OidcVerificationError('email-not-verified');
    }
    if (payload['email'] !== this.#options.allowedServiceAccountEmail) {
      throw new OidcVerificationError('service-account-mismatch');
    }
  }
}
