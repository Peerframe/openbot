"""Real protected Host and Unix framing; native isolation and injected reply loss are fixtures."""
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from product_command_local_host import LocalHost


class LostReplyHost(LocalHost):
    def lookup(self,record,operation,*,include_output):
        self.check_alive(record)
        assert self.calls.count('execute')==1
        self.calls.append('lookup_lost')
        raise EOFError('synthetic command receipt loss')


def main():
    source=sys.stdin.buffer.readline(32769)
    if len(source)>32768:raise ValueError('command_fixture_input_limit')
    config=json.loads(source)
    index=0
    def create(lost):
        nonlocal index
        directory=Path(config['directory'])/str(index)
        index+=1
        directory.mkdir(mode=0o700)
        host_type=LostReplyHost if lost else LocalHost
        return host_type(directory,config['route'],config['timing'],config['controlPublic'].encode(),config['enforcerPrivate'].encode())
    host=create(False)
    try:
        print(json.dumps(dict(socketPath=str(host.socket))),flush=True)
        for line in sys.stdin.buffer:
            request=json.loads(line)
            if request==dict(operation='close'):break
            if request==dict(operation='state'):
                print(json.dumps(dict(calls=list(host.calls),error=host.error)),flush=True)
            elif request in [dict(operation='reset',lost=True),dict(operation='reset',lost=False)]:
                host.close()
                host=create(request['lost'])
                print(json.dumps(dict(socketPath=str(host.socket))),flush=True)
            else:raise ValueError('command_fixture_request_invalid')
    finally:host.close()


if __name__=='__main__':main()
