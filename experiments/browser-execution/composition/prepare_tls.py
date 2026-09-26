"""Generate disposable synthetic certificates; never read or alter an existing trust store."""
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
import os

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def prepare(directory: Path):
    directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    now = datetime.now(timezone.utc)
    authority = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'OpenBot disposable Linux fixture CA')])
    root = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(authority.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=2))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(True, False, False, False, False, True, True, False, False), critical=True)
            .sign(authority, hashes.SHA256()))
    (directory / 'ca.pem').write_bytes(root.public_bytes(serialization.Encoding.PEM))
    for prefix in ('', 'unknown-'):
        key = ec.generate_private_key(ec.SECP256R1())
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'example.com')])
        certificate = (x509.CertificateBuilder().subject_name(subject)
                       .issuer_name(subject if prefix else name).public_key(key.public_key())
                       .serial_number(x509.random_serial_number())
                       .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=2))
                       .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                       .add_extension(x509.SubjectAlternativeName([x509.DNSName('example.com')]), critical=False)
                       .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                       .sign(key if prefix else authority, hashes.SHA256()))
        (directory / (prefix + 'cert.pem')).write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        (directory / (prefix + 'key.pem')).write_bytes(key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    # The disposable CA signing key is deliberately never serialized.


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    prepare(args.output.resolve())
