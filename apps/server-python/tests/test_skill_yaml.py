"""Formats shared with retained JS yaml 2.9.0; never an executable YAML loader."""
import pytest
from openbot_server.employee_knowledge_inputs import parse_skill_document
from openbot_server.control_errors import ControlError


@pytest.mark.parametrize('scalar,expected', [
    ('>-\n  First\n  second', 'First second'), ('|\n  First\n  second','First\nsecond'),
    ('"first\n  second"','first second'), ('value # comment','value'), ('yes','yes'),
    ('on','on'), ('2001-12-15','2001-12-15'), ('1abc','1abc'), ('0b10','0b10'),
    ('1_000','1_000'), ('12:30','12:30'), ('"true"','true'),
])
def test_core_string_forms(scalar,expected):
    document='---\nname: skill\ndescription: '+scalar+'\n---\nBody'
    assert parse_skill_document(document)['description']==expected


def test_flow_map_and_comments():
    document='---\n# comment\nname: skill\ndescription: Test\nmetadata: {author: Owner, yes: no}\n---\nBody'
    assert parse_skill_document(document)['metadata']=={'author':'Owner','yes':'no'}


@pytest.mark.parametrize('scalar',['0123','0o12','0xFF','1e5','1.2e-3','+1','-.5','.NaN','true','null','~'])
def test_typed_core_scalars_are_refused(scalar):
    with pytest.raises(ControlError):
        parse_skill_document('---\nname: skill\ndescription: '+scalar+'\n---\nBody')
