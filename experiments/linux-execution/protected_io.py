"""Small protected-files and bounded Unix framing primitives; no execution authority."""
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import struct

from openbot_server.work_command_contract import strict_json, bounded_value

class Refused(RuntimeError):
    pass

def require(value,code='invalid_request'):
    if not value:raise Refused(code)

def directory(path,uid=0,private=True):
    path=Path(path)
    require(path.is_absolute() and path.resolve()==path,'unsafe_path')
    for part in (path,*path.parents):
        s=part.lstat();require(stat.S_ISDIR(s.st_mode) and s.st_uid==uid and not s.st_mode&0o022,'unsafe_directory')
    if private:require(stat.S_IMODE(path.stat().st_mode)==0o700,'unsafe_directory')
    return path

def read_bytes(path,maximum,*,uid=0,private=True):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd);require(stat.S_ISREG(s.st_mode) and s.st_uid==uid and s.st_nlink==1 and not s.st_mode&0o022,'unsafe_file')
        if private:require(stat.S_IMODE(s.st_mode)==0o600,'unsafe_file')
        require(0<=s.st_size<=maximum,'oversized_file');data=b''
        while len(data)<=maximum:
            chunk=os.read(fd,min(65536,maximum+1-len(data)))
            if not chunk:break
            data+=chunk
        after=os.fstat(fd)
        require(len(data)==s.st_size and (s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'changed_file')
        return data
    finally:os.close(fd)

def fsync_dir(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)

def exclusive(path,value):
    """An uncertain fsync still consumes the name. No unlink/retry compensation."""
    data=bounded_value(value,maximum=32768)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'wb',closefd=False) as out:out.write(data);out.flush();os.fsync(fd)
    finally:os.close(fd)
    fsync_dir(Path(path).parent)

def read_record(path,*,uid=0):return strict_json(read_bytes(path,32768,uid=uid),maximum=32768)
def digest(path):
    h=hashlib.sha256()
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        s=os.fstat(fd);require(stat.S_ISREG(s.st_mode) and s.st_nlink==1,'unsafe_file')
        while True:
            b=os.read(fd,1024*1024)
            if not b:break
            h.update(b)
        a=os.fstat(fd);require((a.st_size,a.st_mtime_ns,a.st_ctime_ns)==(s.st_size,s.st_mtime_ns,s.st_ctime_ns),'changed_file')
    finally:os.close(fd)
    return h.hexdigest()

def receive(sock):
    def exactly(n):
        out=b''
        while len(out)<n:
            b=sock.recv(n-len(out))
            if not b:raise EOFError()
            out+=b
        return out
    size=struct.unpack('!I',exactly(4))[0];require(1<=size<=32768,'oversized_frame')
    return strict_json(exactly(size),maximum=32768)

def send(sock,value):
    data=bounded_value(value,maximum=32768);sock.sendall(struct.pack('!I',len(data))+data)

def peer_uid(sock):
    require(hasattr(socket,'SO_PEERCRED'),'unsupported_peer_credentials')
    return struct.unpack('3i',sock.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]
