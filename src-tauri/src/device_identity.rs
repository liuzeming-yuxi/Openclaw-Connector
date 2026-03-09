use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{SigningKey, Signer, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub public_key_pem: String,
    pub private_key_pem: String,
}

#[derive(Serialize, Deserialize)]
struct StoredIdentity {
    version: u32,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "publicKeyPem")]
    public_key_pem: String,
    #[serde(rename = "privateKeyPem")]
    private_key_pem: String,
    #[serde(rename = "createdAtMs")]
    created_at_ms: u64,
}

/// Load or create device identity from a file.
pub fn load_or_create(path: &Path) -> Result<DeviceIdentity, String> {
    if path.exists() {
        let raw = fs::read_to_string(path)
            .map_err(|e| format!("failed to read identity: {e}"))?;
        let stored: StoredIdentity = serde_json::from_str(&raw)
            .map_err(|e| format!("failed to parse identity: {e}"))?;
        if stored.version == 1 {
            return Ok(DeviceIdentity {
                device_id: stored.device_id,
                public_key_pem: stored.public_key_pem,
                private_key_pem: stored.private_key_pem,
            });
        }
    }

    let identity = generate()?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create identity dir: {e}"))?;
    }

    let stored = StoredIdentity {
        version: 1,
        device_id: identity.device_id.clone(),
        public_key_pem: identity.public_key_pem.clone(),
        private_key_pem: identity.private_key_pem.clone(),
        created_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    };

    let json = serde_json::to_string_pretty(&stored)
        .map_err(|e| format!("failed to serialize identity: {e}"))?;
    fs::write(path, format!("{json}\n"))
        .map_err(|e| format!("failed to write identity: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }

    eprintln!("[device_identity] created new device identity: {}", identity.device_id);
    Ok(identity)
}

/// Generate a new Ed25519 device identity.
fn generate() -> Result<DeviceIdentity, String> {
    let mut rng = rand::thread_rng();
    let signing_key = SigningKey::generate(&mut rng);
    let verifying_key: VerifyingKey = signing_key.verifying_key();

    let private_key_pem = encode_ed25519_private_pem(&signing_key);
    let public_key_pem = encode_ed25519_public_pem(&verifying_key);
    let device_id = fingerprint_public_key(&verifying_key);

    Ok(DeviceIdentity {
        device_id,
        public_key_pem,
        private_key_pem,
    })
}

/// Sign the device auth payload and return base64url signature.
pub fn sign_payload(private_key_pem: &str, payload: &str) -> Result<String, String> {
    let signing_key = parse_ed25519_private_pem(private_key_pem)?;
    let signature = signing_key.sign(payload.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

/// Get the raw 32-byte public key as base64url.
pub fn public_key_raw_base64url(public_key_pem: &str) -> Result<String, String> {
    let verifying_key = parse_ed25519_public_pem(public_key_pem)?;
    Ok(URL_SAFE_NO_PAD.encode(verifying_key.as_bytes()))
}

/// Build the V3 device auth payload string.
#[allow(clippy::too_many_arguments)]
pub fn build_auth_payload_v3(
    device_id: &str,
    client_id: &str,
    client_mode: &str,
    role: &str,
    scopes: &[&str],
    signed_at_ms: u64,
    token: &str,
    nonce: &str,
    platform: &str,
) -> String {
    let scopes_str = scopes.join(",");
    format!(
        "v3|{device_id}|{client_id}|{client_mode}|{role}|{scopes_str}|{signed_at_ms}|{token}|{nonce}|{platform}|"
    )
}

/// SHA-256 hex fingerprint of the raw Ed25519 public key bytes.
fn fingerprint_public_key(verifying_key: &VerifyingKey) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifying_key.as_bytes());
    hex::encode(hasher.finalize())
}

// ── PEM encoding/decoding ──

/// Ed25519 PKCS#8 v1 prefix (48 bytes total: 16 header + 32 key)
const PKCS8_ED25519_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// Ed25519 SPKI prefix (12 bytes header + 32 key)
const SPKI_ED25519_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
    0x70, 0x03, 0x21, 0x00,
];

fn encode_ed25519_private_pem(key: &SigningKey) -> String {
    let mut der = Vec::with_capacity(48);
    der.extend_from_slice(&PKCS8_ED25519_PREFIX);
    der.extend_from_slice(key.as_bytes());
    let b64 = base64::engine::general_purpose::STANDARD.encode(&der);
    let mut pem = String::from("-----BEGIN PRIVATE KEY-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).unwrap());
        pem.push('\n');
    }
    pem.push_str("-----END PRIVATE KEY-----\n");
    pem
}

fn encode_ed25519_public_pem(key: &VerifyingKey) -> String {
    let mut der = Vec::with_capacity(44);
    der.extend_from_slice(&SPKI_ED25519_PREFIX);
    der.extend_from_slice(key.as_bytes());
    let b64 = base64::engine::general_purpose::STANDARD.encode(&der);
    let mut pem = String::from("-----BEGIN PUBLIC KEY-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).unwrap());
        pem.push('\n');
    }
    pem.push_str("-----END PUBLIC KEY-----\n");
    pem
}

fn parse_ed25519_private_pem(pem: &str) -> Result<SigningKey, String> {
    let b64: String = pem.lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();
    let der = base64::engine::general_purpose::STANDARD.decode(&b64)
        .map_err(|e| format!("invalid PEM base64: {e}"))?;
    if der.len() == 48 && der[..16] == PKCS8_ED25519_PREFIX {
        let key_bytes: [u8; 32] = der[16..48].try_into()
            .map_err(|_| "invalid key length".to_string())?;
        Ok(SigningKey::from_bytes(&key_bytes))
    } else {
        Err(format!("unsupported private key format (len={})", der.len()))
    }
}

fn parse_ed25519_public_pem(pem: &str) -> Result<VerifyingKey, String> {
    let b64: String = pem.lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();
    let der = base64::engine::general_purpose::STANDARD.decode(&b64)
        .map_err(|e| format!("invalid PEM base64: {e}"))?;
    if der.len() == 44 && der[..12] == SPKI_ED25519_PREFIX {
        let key_bytes: [u8; 32] = der[12..44].try_into()
            .map_err(|_| "invalid key length".to_string())?;
        VerifyingKey::from_bytes(&key_bytes)
            .map_err(|e| format!("invalid public key: {e}"))
    } else {
        Err(format!("unsupported public key format (len={})", der.len()))
    }
}

/// Hex encoding helper (avoid pulling in the `hex` crate).
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}
