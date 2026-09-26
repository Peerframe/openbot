"""Authored synthetic originals and byte-level OpenAI Responses wire assertions."""
import base64
import hashlib
import json
import struct
import zlib

MODEL = 'synthetic-media-model'
KEY = 'synthetic-media-model-key-not-real'
PNG_MARKER = b'OPENBOT_SYNTHETIC_PNG_PRIVATE_BYTES_927'
PDF_MARKER = b'OPENBOT_SYNTHETIC_PDF_PRIVATE_BYTES_9917'
REPORT = '# Synthetic media report\n\nThe original PNG image and PDF document were supplied together.\n'
SUMMARY = 'The two original attachments were inspected and a Markdown report was prepared.'


def originals():
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    png=(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',2,2,8,2,0,0,0))
         +chunk(b'tEXt',b'Fixture\0'+PNG_MARKER)
         +chunk(b'IDAT',zlib.compress(b'\0\xff\0\0\0\xff\0\0\0\0\xff\xff\xff\xff'))+chunk(b'IEND',b''))
    stream=b'BT /F1 12 Tf 24 72 Td ('+PDF_MARKER+b') Tj ET\n'
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
             b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
             b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
             b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'endstream']
    pdf=bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');offsets=[0]
    for number,value in enumerate(objects,1):
        offsets.append(len(pdf));pdf.extend(str(number).encode()+b' 0 obj\n'+value+b'\nendobj\n')
    start=len(pdf);pdf.extend(b'xref\n0 6\n0000000000 65535 f \n')
    for offset in offsets[1:]:pdf.extend(f'{offset:010d} 00000 n \n'.encode())
    pdf.extend(b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+str(start).encode()+b'\n%%EOF\n')
    return [('图像.png','image/png',png),('原始文档.pdf','application/pdf',bytes(pdf))]


def assert_wire(request):
    assert request.method=='POST' and str(request.url)=='https://api.openai.com/v1/responses'
    assert request.headers['authorization']=='Bearer '+KEY
    assert int(request.headers['content-length'])==len(request.content)
    body=json.loads(request.content);assert body['model']==MODEL
    found=[];texts=[]
    for message in body['input']:
        if message.get('type') in ('function_call','function_call_output'):continue
        content=message.get('content',[])
        if type(content) is str:texts.append(content);continue
        for part in content:
            kind=part['type']
            if kind in ('input_text','output_text'):texts.append(part['text']);continue
            assert kind in ('input_image','input_file'),kind
            uri=part.get('image_url') or part.get('file_data')
            header,encoded=uri.split(',',1)
            data=base64.b64decode(encoded,validate=True)
            found.append((kind,header,data,part.get('filename')))
    expected=originals();assert len(found)==2
    for (kind,header,data,name),(filename,mime,raw) in zip(found,expected):
        assert header=='data:'+mime+';base64' and data==raw
        assert kind==('input_file' if mime=='application/pdf' else 'input_image')
        assert name==(filename if mime=='application/pdf' else None)
    # The exact descriptors establish original names/IDs in addition to the protocol's file name.
    descriptors=[text for text in texts if text.startswith('Untrusted explicitly referenced task attachments: ')]
    assert len(descriptors)==1
    items=json.loads(descriptors[0].split(': ',1)[1]);assert len(items)==2
    for item,(filename,mime,data) in zip(items,expected):
        assert item['name']==filename and item['mediaType']==mime
        assert item['sha256']==hashlib.sha256(data).hexdigest() and item['untrusted'] is True
    review=any('You independently review source-grounded answers' in text for text in texts)
    if review:
        evidence=[json.loads(text) for text in texts if text.startswith('{') and 'openbot.source-grounded-review/v1' in text]
        assert len(evidence)==1 and evidence[0]['finalAnswer']==SUMMARY
        attachments=evidence[0]['media']['attachments'];assert len(attachments)==2
        for item,(filename,mime,data) in zip(attachments,expected):
            assert item['name']==filename and item['mediaType']==mime and item['mode']=='binary'
            assert item['sha256']==hashlib.sha256(data).hexdigest() and item['sizeBytes']==len(data)
    return body,review,dict(stage='review' if review else 'producer',protocol='responses-v1',
        media=[dict(name=n,mediaType=m,sizeBytes=len(d),sha256=hashlib.sha256(d).hexdigest()) for n,m,d in expected])


def check_history(history):
    """Inspect decoded protobuf Payload bytes; JSON history itself necessarily base64-wraps them."""
    forbidden=[KEY.encode(),PNG_MARKER,PDF_MARKER,b'data:image/png;base64,',b'data:application/pdf;base64,']
    for _,_,data in originals():forbidden.extend((data,base64.b64encode(data)))
    count=0
    def visit(message):
        nonlocal count
        if message.DESCRIPTOR.full_name=='temporal.api.common.v1.Payload':
            count+=1
            for value in forbidden:assert value not in message.data,'Raw media/key leaked to Payload data'
        for field,value in message.ListFields():
            if field.message_type is None:continue
            if field.message_type.GetOptions().map_entry:
                for child in value.values():
                    if hasattr(child,'ListFields'):visit(child)
            elif field.is_repeated:
                for child in value:visit(child)
            else:visit(value)
    for event in history.events:visit(event)
    assert count>0
    return count
