# Create a config file for OpenSSL
$configContent = @"
[ req ]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
[ dn ]
CN = Social Stream Ninja
O = Steve Seguin
L = Canada
emailAddress = steve@seguin.email
OU = socialstream.ninja
[ v3_req ]
keyUsage = digitalSignature
extendedKeyUsage = codeSigning
"@

Set-Content -Path openssl.cnf -Value $configContent

Write-Host "Creating certificate for Social Stream Ninja..."

# Generate private key
& openssl genrsa -out certs/key.pem 2048

# Generate certificate using the config
& openssl req -new -x509 -key certs/key.pem -out certs/cert.pem -days 3650 -config openssl.cnf -extensions v3_req

# Create PFX file for electron-builder (change the password!)
$password = "CHANGE_ME"
& openssl pkcs12 -export -out certs/socialstream.pfx -inkey certs/key.pem -in certs/cert.pem -name "Social Stream Ninja" -password pass:$password

Write-Host "Certificate created: certs/socialstream.pfx"
Write-Host "Remember to update your package.json with the certificate info and password!"