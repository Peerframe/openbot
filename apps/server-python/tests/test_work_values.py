"""Untrusted JSON and budget boundaries before control-domain persistence."""
import math
import pytest

from openbot_server.work_values import InvalidWork, canonical, receipt, tokens


@pytest.mark.parametrize('value', [True, False, None, -1, 1.5, '10', 1_000_000_001])
def test_token_reservations_are_bounded_integers(value):
    with pytest.raises(InvalidWork):
        tokens(value)


@pytest.mark.parametrize('value', [float('nan'), float('inf'), 2**53, b'bytes', {'x': '\0'},
                                   {'x': '\ud800'}, {1: 'numeric-key'}, {'x': 'z'*16385},
                                   {'x': [0]*4096}, {'': 'empty-key'}])
def test_invalid_or_excessive_intent_cannot_be_hashed_as_approval(value):
    with pytest.raises(InvalidWork):
        canonical(value)


def test_depth_and_cycles_fail_with_a_bounded_error():
    value = {}
    value['self'] = value
    with pytest.raises(InvalidWork, match='intent_structure_limit'):
        canonical(value)


def test_digest_is_order_independent_but_content_sensitive():
    assert canonical({'a':1,'b':['值',False]}) == canonical({'b':['值',False],'a':1})
    assert canonical({'a':1})[1] != canonical({'a':2})[1]


@pytest.mark.parametrize('value', [{}, {'source':'x','reference':'r','sha256':'bad'},
    {'source':'x','reference':'r','sha256':'a'*64,'approved':True}])
def test_only_bounded_receipt_references_are_accepted(value):
    with pytest.raises(InvalidWork):
        receipt(value)
