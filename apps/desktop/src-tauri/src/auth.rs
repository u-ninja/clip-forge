//! Per-launch session secret and request signing for the local API (ADR-010).
//!
//! The secret is generated here, handed to the API child process at spawn, and never leaves the
//! Rust process otherwise: the frontend calls `api_request` and never sees it.
//! Wire format must match `services/api/src/auth.ts`.

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

pub const HEADER_TIMESTAMP: &str = "x-clipforge-timestamp";
pub const HEADER_NONCE: &str = "x-clipforge-nonce";
pub const HEADER_SIGNATURE: &str = "x-clipforge-signature";

pub struct SessionSecret([u8; 32]);

/// Headers to attach to one request. Each set is single-use (nonce) and short-lived (timestamp).
pub struct SignedHeaders {
    pub timestamp: String,
    pub nonce: String,
    pub signature: String,
}

impl SessionSecret {
    pub fn generate() -> Result<Self, getrandom::Error> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)?;
        Ok(Self(bytes))
    }

    /// Hex form, only for handing to the API child's environment and for log redaction.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    pub fn sign(
        &self,
        method: &str,
        url: &str,
        body: &[u8],
    ) -> Result<SignedHeaders, getrandom::Error> {
        let timestamp = now_ms().to_string();
        let nonce = random_hex(16)?;
        let signature = compute_signature(&self.0, method, url, &timestamp, &nonce, body);
        Ok(SignedHeaders {
            timestamp,
            nonce,
            signature,
        })
    }
}

// Never print the secret, even in debug output.
impl fmt::Debug for SessionSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SessionSecret(<redacted>)")
    }
}

pub fn compute_signature(
    secret: &[u8],
    method: &str,
    url: &str,
    timestamp: &str,
    nonce: &str,
    body: &[u8],
) -> String {
    let body_hash = hex::encode(Sha256::digest(body));
    let canonical = format!(
        "CFL1\n{}\n{url}\n{timestamp}\n{nonce}\n{body_hash}",
        method.to_uppercase()
    );
    // HMAC accepts keys of any length, so this cannot fail.
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(canonical.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn random_hex(bytes: usize) -> Result<String, getrandom::Error> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf)?;
    Ok(hex::encode(buf))
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_typescript_test_vector() {
        // Same vector as services/api/src/auth.test.ts.
        let sig = compute_signature(
            &[0u8; 32],
            "GET",
            "/api/v1/version",
            "1700000000000",
            &"0".repeat(32),
            b"",
        );
        assert_eq!(
            sig,
            "e5f2ecbc404caa5c33f3cac65db6159a98bddb22e6e8a66e522370717a518682"
        );
    }

    #[test]
    fn secrets_are_random_and_never_debug_printed() {
        let a = SessionSecret::generate().unwrap();
        let b = SessionSecret::generate().unwrap();
        assert_ne!(a.to_hex(), b.to_hex());
        assert_eq!(a.to_hex().len(), 64);
        assert!(!format!("{a:?}").contains(&a.to_hex()));
    }

    #[test]
    fn signatures_use_fresh_nonces() {
        let s = SessionSecret::generate().unwrap();
        let x = s.sign("GET", "/api/v1/version", b"").unwrap();
        let y = s.sign("GET", "/api/v1/version", b"").unwrap();
        assert_ne!(x.nonce, y.nonce);
        assert_ne!(x.signature, y.signature);
    }
}
