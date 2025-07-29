# Code Signing Certificate

This repository includes the public code signing certificate (`code-signing-cert.pem`) used to sign official releases of Social Stream Ninja.

## Verifying Releases

The included certificate can be used to verify that downloaded binaries were signed by the official Social Stream Ninja developer.

### Certificate Details
- **File**: `code-signing-cert.pem`
- **Subject**: Social Stream Ninja
- **Organization**: Steve Seguin
- **Email**: steve@seguin.email
- **Valid Until**: 2035-07-27

### Windows Verification

To verify a signed executable on Windows:
```powershell
# View signature details
Get-AuthenticodeSignature "socialstreamninja-setup.exe"

# Extract and compare certificate
$cert = (Get-AuthenticodeSignature "socialstreamninja-setup.exe").SignerCertificate
$cert.Thumbprint
```

### Manual Certificate Inspection

View certificate details:
```bash
openssl x509 -in code-signing-cert.pem -text -noout
```

Extract fingerprint:
```bash
openssl x509 -in code-signing-cert.pem -fingerprint -noout
```

## Security Note

- This is the PUBLIC certificate only - safe to distribute
- The private key is never included in the repository
- Official builds are signed with the corresponding private key
- Always verify downloads match this certificate to ensure authenticity