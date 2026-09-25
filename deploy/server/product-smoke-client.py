"""Synthetic HTTP/retained parser check, sent on stdin to the disposable product container only."""
import hashlib
import io
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request
import zipfile

base,phase=sys.argv[1:]
origin='http://localhost:3001'
password='openbot-product-smoke-synthetic-owner'
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
cookie=''


def request(path,body=None,*,raw=False,headers=None,status=200):
    head={'Origin':origin,'Cookie':cookie,**(headers or {})}
    if body is not None and not raw:body=json.dumps(body).encode();head['Content-Type']='application/json'
    req=urllib.request.Request(base+path,data=body,headers=head)
    try:response=opener.open(req,timeout=70)
    except urllib.error.HTTPError as error:response=error
    with response:
        assert response.status==status,('unexpected_http_status',path,response.status)
        data=response.read(2*1024*1024+1);assert len(data)<=2*1024*1024
        return data,response.headers


health=json.loads(request('/health')[0]);assert health['phase']=='python-product-candidate'
assert b'<html' in request('/')[0].lower()
_,headers=request('/api/v1/auth/login',{'password':password})
cookie=headers['Set-Cookie'].split(';')[0];assert cookie.startswith('openbot_session=')
assert json.loads(request('/api/v1/nodes')[0])['nodes']==[]
assert json.loads(request('/api/v1/settings/model')[0])['status']=='unconfigured'
record=Path('/var/lib/openbot/smoke-record.json')
key=Path('/var/lib/openbot/objects/model-connections.key')
assert len(key.read_bytes())==32 and key.stat().st_mode&0o077==0
key_hash=hashlib.sha256(key.read_bytes()).hexdigest()
if phase=='create':
    channel=json.loads(request('/api/v1/channels',{'name':'Synthetic container lifecycle','botIds':[]},status=201)[0])['channel']
    # Locally authored minimal Office and PDF bytes: no retained TS test-oracle assets.
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>OpenBot container evidence</w:t></w:r></w:p></w:body></w:document>')
    text=b'BT /F1 18 Tf 30 100 Td (OpenBot container evidence) Tj ET'
    objects=[b'<</Type /Catalog /Pages 2 0 R>>',b'<</Type /Pages /Kids [3 0 R] /Count 1>>',
        b'<</Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>>',
        b'<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>',b'<</Length '+str(len(text)).encode()+b'>>\nstream\n'+text+b'\nendstream']
    pdf=b'%PDF-1.4\n';offsets=[0]
    for i,obj in enumerate(objects,1):offsets.append(len(pdf));pdf+=str(i).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
    start=len(pdf);pdf+=b'xref\n0 6\n0000000000 65535 f \n'+b''.join(f'{n:010d} 00000 n \n'.encode() for n in offsets[1:])
    pdf+=b'trailer <</Size 6 /Root 1 0 R>>\nstartxref\n'+str(start).encode()+b'\n%%EOF\n'
    attachments=[]
    for extension,data in [('docx',stream.getvalue()),('pdf',pdf)]:
        path='/api/v1/channels/'+channel['id']+'/attachments'
        item=json.loads(request(path,data,raw=True,headers={'Content-Type':'application/octet-stream',
            'X-OpenBot-Filename':'synthetic.'+extension},status=201)[0])['attachment']
        processed=json.loads(request(path+'/'+item['id']+'/process',{'operation':'extract'})[0])['attachment']
        assert processed['processing']['characters']>=25 and processed['processing']['truncated'] is False
        attachments.append({'id':item['id'],'sha256':hashlib.sha256(data).hexdigest()})
    record.write_text(json.dumps({'channel':channel['id'],'attachments':attachments,'keyHash':key_hash}));record.chmod(0o600)
    # Check actual offline OCR engine initialization with a synthetic blank PNG. Blank text is expected.
    import asyncio,struct,zlib
    sys.path.insert(0,'/workspace/apps/server-python/src')
    from openbot_server.attachment_processing import NodeAttachmentParser,parse_process_input
    def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',100,100,8,0,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\xff'*100)*100))+chunk(b'IEND',b'')
    result=asyncio.run(NodeAttachmentParser(node_executable='/usr/local/bin/node',module_root='/workspace/node_modules').parse(
        png,'png',parse_process_input({'operation':'ocr'})))
    assert result=={'text':'','truncated':False}
else:
    assert phase=='restart'
    saved=json.loads(record.read_text());assert saved['keyHash']==key_hash
    assert any(v['id']==saved['channel'] for v in json.loads(request('/api/v1/channels')[0])['channels'])
    for item in saved['attachments']:
        path='/api/v1/channels/'+saved['channel']+'/attachments/'+item['id']
        assert json.loads(request(path)[0])['attachment']['processing']['characters']>=25
        assert hashlib.sha256(request(path+'/content')[0]).hexdigest()==item['sha256']
print(json.dumps({'phase':phase,'ownerHttp':True,'builtWeb':True,'persistentKeyAndFiles':True,
    'parsers': ['docx','pdf','ocr-blank-initialization'] if phase=='create' else []}))
