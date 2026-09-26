"""Disposable OpenSSL-issued test credentials. Never a product certificate authority."""
from pathlib import Path
import shutil
import subprocess

SERVER_NAME = 'temporal.openbot.internal'


class CertificateFixture:
    def __init__(self, directory):
        self.root = Path(directory)
        self.root.mkdir(mode=0o700)
        self.binary = shutil.which('openssl')
        if not self.binary:
            raise ValueError('The explicit TLS fixture requires the platform OpenSSL CLI')
        self.version = self.command('version').stdout.decode().strip()
        self.engine = self.root / 'engine'
        self.engine.mkdir(mode=0o700)
        for name in ('server-ca', 'client-ca', 'unknown-ca', 'replacement-ca'):
            self.authority(name)
        self.leaf('server', 'server-ca', 'serverAuth,clientAuth', SERVER_NAME)
        self.leaf('client', 'client-ca', 'clientAuth', 'control-fixture')
        self.leaf('unknown-client', 'unknown-ca', 'clientAuth', 'untrusted-fixture')
        self.leaf('replacement-client', 'replacement-ca', 'clientAuth', 'replacement-control-fixture')
        for name in ('server.pem', 'server.key', 'server-ca.pem', 'client-ca.pem'):
            # Individual file mounts bypass the private host parent inside the trusted engine.
            # No other host user can traverse root; no CA private key is mounted.
            path = self.engine / name
            path.write_bytes((self.root / name).read_bytes())
            path.chmod(0o444)
        for path in self.root.iterdir():
            if path.is_file():
                path.chmod(0o600)

    def command(self, *args):
        result = subprocess.run([self.binary, *args], cwd=self.root, capture_output=True, timeout=20)
        if result.returncode:
            # Avoid forwarding issuer/key material or arbitrary process output into test logs.
            raise RuntimeError('OpenSSL fixture operation failed: ' + args[0])
        return result

    def authority(self, name):
        config = self.root / (name + '.cnf')
        config.write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n'
            '[dn]\nCN=' + name + '\n[ca]\nbasicConstraints=critical,CA:TRUE\n'
            'keyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n')
        self.command('req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
            '-config', str(config), '-keyout', name + '.key', '-out', name + '.pem')

    def leaf(self, name, issuer, usage, subject):
        extension = self.root / (name + '.cnf')
        extension.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
            'extendedKeyUsage=' + usage + '\nsubjectAltName=DNS:' + subject + '\n')
        self.command('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=' + subject,
            '-keyout', name + '.key', '-out', name + '.csr')
        self.command('x509', '-req', '-in', name + '.csr', '-CA', issuer + '.pem', '-CAkey', issuer + '.key',
            '-CAcreateserial', '-sha256', '-days', '1', '-extfile', str(extension), '-out', name + '.pem')

    def settings(self, name='client'):
        return {'ca': str(self.root / 'server-ca.pem'), 'certificate': str(self.root / (name + '.pem')),
            'key': str(self.root / (name + '.key')), 'server_name': SERVER_NAME}

    def rotate_client_ca(self):
        path = self.engine / 'client-ca.pem'
        path.chmod(0o600)
        path.write_bytes((self.root / 'replacement-ca.pem').read_bytes())
        path.chmod(0o444)
