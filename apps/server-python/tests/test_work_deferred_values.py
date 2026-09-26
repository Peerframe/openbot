"""Tests for work_deferred_values.parse_proposal."""
import json
import unittest

from openbot_server.work_deferred_values import MAX_JSON_ARGUMENT_BYTES, parse_proposal
from openbot_server.work_values import canonical
from openbot_server.work_values import InvalidWork


class ParseProposalTests(unittest.TestCase):
    def _expect_invalid(self, value):
        with self.assertRaises(InvalidWork):
            parse_proposal(value)

    def test_normal_dict_is_detached(self):
        nested = {'b': [1, 2, {'c': 'x'}], 'a': 1}
        inner = nested['b'][2]
        result = parse_proposal({'call_id': 'call-1', 'tool': 'echo',
                                 'arguments': nested})
        self.assertEqual(result,
                         {'call_id': 'call-1', 'tool': 'echo',
                          'arguments': {'a': 1, 'b': [1, 2, {'c': 'x'}]}})
        self.assertIsNot(result['arguments'], nested)
        nested['a'] = 99
        nested['b'][2]['c'] = 'mutated'
        self.assertEqual(inner, {'c': 'mutated'})
        self.assertEqual(result['arguments']['a'], 1)
        self.assertEqual(result['arguments']['b'][2]['c'], 'x')

    def test_normal_json_object_string(self):
        result = parse_proposal({'call_id': 'call-2', 'tool': 'echo',
                                 'arguments': '{"b":[1,2],"a":"x"}'})
        self.assertEqual(result['arguments'], {'a': 'x', 'b': [1, 2]})

    def test_dict_and_json_string_agree_via_canonical(self):
        payload = {'nested': {'list': [1, {'k': 'v'}], 'n': 1.5}, 'flag': True}
        from_dict = parse_proposal({'call_id': 'c', 'tool': 't', 'arguments': payload})
        from_text = parse_proposal({'call_id': 'c', 'tool': 't',
                                    'arguments': json.dumps(payload)})
        self.assertEqual(canonical(from_dict['arguments']),
                         canonical(from_text['arguments']))

    def test_nested_dict_input_deeply_detached(self):
        nested = {'outer': {'inner': [10, 20]}}
        result = parse_proposal({'call_id': 'c', 'tool': 't', 'arguments': nested})
        self.assertIsNot(result['arguments'], nested)
        self.assertIsNot(result['arguments']['outer'], nested['outer'])
        self.assertIsNot(result['arguments']['outer']['inner'],
                         nested['outer']['inner'])
        nested['outer']['inner'].append(30)
        self.assertEqual(result['arguments']['outer']['inner'], [10, 20])

    def test_exact_shape_requirements(self):
        good = {'call_id': 'c', 'tool': 't', 'arguments': {'a': 1}}
        self._expect_invalid({'call_id': 'c', 'tool': 't'})
        self._expect_invalid({'call_id': 'c', 'tool': 't', 'arguments': {},
                              'extra': 1})
        self._expect_invalid([])
        self._expect_invalid('not a dict')
        self._expect_invalid(None)
        self._expect_invalid({'call_id': 'c', 'tool': 't', 'arguments': 5})
        self._expect_invalid({'call_id': 'c', 'tool': 't', 'arguments': ['a']})
        self._expect_invalid({'call_id': 'c', 'tool': 't', 'arguments': None})
        self._expect_invalid({'call_id': 1, 'tool': 't', 'arguments': {}})
        self._expect_invalid({'call_id': 'c', 'tool': 5, 'arguments': {}})
        self._expect_invalid({'call_id': '', 'tool': 't', 'arguments': {}})
        self._expect_invalid({'call_id': 'c', 'tool': '   ', 'arguments': {}})
        self._expect_invalid({'call_id': 'bad\0id', 'tool': 't', 'arguments': {}})
        # Sanity: the good shape still parses.
        self.assertEqual(parse_proposal(good)['call_id'], 'c')

    def test_nested_duplicate_keys_rejected(self):
        self._expect_invalid({'call_id': 'c', 'tool': 't',
                              'arguments': '{"a":{"b":1,"b":2}}'})
        self._expect_invalid({'call_id': 'c', 'tool': 't',
                              'arguments': '{"a":[{"b":1,"b":2}]}'})
        self._expect_invalid({'call_id': 'c', 'tool': 't',
                              'arguments': '{"a":1,"a":2}'})
        self.assertEqual(parse_proposal({'call_id': 'c', 'tool': 't',
                                         'arguments': '{"a":{"b":1}}'}),
                         {'call_id': 'c', 'tool': 't',
                          'arguments': {'a': {'b': 1}}})

    def test_non_finite_numbers_rejected(self):
        for raw in ('{"a":NaN}', '{"a":Infinity}', '{"a":-Infinity}',
                    '{"a":[1,NaN]}', '{"a":{"b":Infinity}}'):
            self._expect_invalid({'call_id': 'c', 'tool': 't', 'arguments': raw})
        # A finite float dict still works.
        result = parse_proposal({'call_id': 'c', 'tool': 't',
                                 'arguments': {'a': 1.5}})
        self.assertEqual(result['arguments'], {'a': 1.5})

    def test_deep_structure_rejected(self):
        deep = current = {}
        for _ in range(30):
            current['n'] = {}
            current = current['n']
        self._expect_invalid({'call_id': 'c', 'tool': 't', 'arguments': deep})
        self._expect_invalid({'call_id': 'c', 'tool': 't',
                              'arguments': json.dumps(deep)})

    def test_oversize_arguments_rejected(self):
        oversize = {'blob': 'a' * 40000}
        self._expect_invalid({'call_id': 'c', 'tool': 't', 'arguments': oversize})
        self._expect_invalid({'call_id': 'c', 'tool': 't',
                              'arguments': json.dumps(oversize)})
        raw = json.dumps({'blob': 'a' * (MAX_JSON_ARGUMENT_BYTES + 1)})
        self.assertTrue(raw.startswith('{"blob": "'))
        self._expect_invalid({'call_id': 'c', 'tool': 't', 'arguments': raw})

    def test_scalar_and_list_json_rejected(self):
        for raw in ('5', '"text"', '[1,2,3]', 'null', 'true', '[]', '{}x'):
            self._expect_invalid({'call_id': 'c', 'tool': 't', 'arguments': raw})

    def test_invalid_utf8_and_unicode_rejected(self):
        # bytes are not an accepted argument type at all.
        self._expect_invalid({'call_id': 'c', 'tool': 't',
                              'arguments': b'{"a":1}'})
        self._expect_invalid({'call_id': 'c', 'tool': 't',
                              'arguments': b'{"a":"\xff\xfe"}'})
        # Lone surrogates fail the strict utf-8 encode inside the decode path.
        self._expect_invalid({'call_id': 'c', 'tool': 't',
                              'arguments': '\ud800'})
        self._expect_invalid({'call_id': 'c', 'tool': 't',
                              'arguments': {'a': '\ud800'}})
        self._expect_invalid({'call_id': 'c', 'tool': 't',
                              'arguments': {'bad\0key': 1}})
        self._expect_invalid({'call_id': 'c', 'tool': 't',
                              'arguments': {'a': 'has\0nul'}})

    def test_errors_do_not_echo_untrusted_content(self):
        marker = 'MARKER-7f3a'
        cases = [
            {'call_id': marker + '\0', 'tool': 't', 'arguments': {}},
            {'call_id': 'c', 'tool': 't', 'arguments': '{"a":1,"a":2}'},
            {'call_id': 'c', 'tool': 't', 'arguments': '{"a":' + marker + '}'},
            {'call_id': 'c', 'tool': 't', 'arguments': 'not json ' + marker},
            {'call_id': 'c', 'tool': 't', 'arguments': marker},
            {'call_id': 'c', 'tool': 't', 'arguments': 5},
            {'call_id': 'c', 'tool': 't', 'extra': marker},
        ]
        for case in cases:
            with self.assertRaises(InvalidWork) as caught:
                parse_proposal(case)
            self.assertNotIn(marker, str(caught.exception))


if __name__ == '__main__':
    unittest.main()


def test_decoder_recursion_becomes_bounded_invalid_work():
    from openbot_server.work_values import InvalidWork
    import pytest
    value = {'call_id':'c', 'tool':'t', 'arguments':'{"x":' + '['*20000 + '0' + ']'*20000 + '}'}
    with pytest.raises(InvalidWork, match='invalid_json_arguments'):
        parse_proposal(value)


def test_large_arguments_are_explicit_bounded_and_leave_original_intents_small():
    import pytest
    proposal=dict(call_id='c',tool='write_report',arguments=dict(name='report.md',markdown='x'*24000))
    with pytest.raises(InvalidWork):parse_proposal(proposal)
    large=parse_proposal(proposal,large_arguments=True)
    assert large==proposal and large['arguments'] is not proposal['arguments']
    with pytest.raises(InvalidWork):canonical(large['arguments'])
    with pytest.raises(InvalidWork):parse_proposal({**proposal,'arguments':{'x':'x'*65536}},large_arguments=True)
