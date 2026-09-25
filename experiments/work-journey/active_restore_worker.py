"""Accepted scripted ports around the product Worker, with a restored-apply tripwire."""
import argparse
import asyncio
import json
from pathlib import Path
import sys


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--repo',type=Path,required=True)
    repo=parser.parse_args().repo.resolve()
    sys.path[:0]=[str(repo/'experiments/work-journey'),str(repo/'apps/server-python/src'),
                 str(repo/'apps/agent-runtime-python/src')]
    import control
    import product_approval_worker
    config=control.settings();original=control.http
    def guarded(path,body=None,**kwargs):
        if body and path=='/operations' and body.get('intent',{}).get('kind')=='write':
            if body.get('taskId') in config.get('forbid_apply',[]):
                Path(config['directory'],'forbidden-apply').write_text('refused')
                raise AssertionError('Restored unknown/cancelled Action attempted another apply')
        if path.startswith('/operations/') and body is None:
            with Path(config['directory'],'lookup-observations.jsonl').open('a') as stream:
                stream.write(json.dumps({'actionId':path.rsplit('/',1)[1]})+'\n')
        return original(path,body,**kwargs)
    control.http=guarded
    asyncio.run(product_approval_worker.main())


if __name__=='__main__':main()
