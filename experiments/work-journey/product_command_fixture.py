"""Public synthetic evidence shared by the product command qualification probes."""
CSV=b'label,value\nalpha,12\nbeta,8\ngamma,5\n'
SUMMARY='The supplied values 12, 8 and 5 total 25. The command output and report are attached.'
REPORT='# Synthetic command result\n\nThe supplied CSV contains 12, 8 and 5; their sum is **25**.\n'
ARGUMENTS=dict(argv=['/bin/cp','/input/input-01','/output/result.csv'],
    output=dict(name='result.csv',mediaType='text/csv',maxBytes=65536))
