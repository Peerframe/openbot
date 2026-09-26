"""Bind the existing deferred-tool envelope to one command Action and operation digest."""
from .work_command_contract import CommandIntent, DispatchOperation, derive_operation, parse
from .work_values import WorkConflict, canonical


def action_command(intent):
    """The wrapper is stored only by Control; it is never an extra wire authority format."""
    if type(intent) is not dict:
        raise WorkConflict('command_intent_changed')
    canonical(intent)
    if intent.get('kind') == 'work_command':
        return parse(CommandIntent, intent)
    if (set(intent) != {'kind', 'tool', 'arguments', 'effect'}
            or intent.get('kind') != 'deferred_tool' or intent.get('tool') != 'run_command'):
        raise WorkConflict('command_intent_changed')
    command = parse(CommandIntent, intent['effect'])
    arguments = dict(argv=command.command.argv, output=command.command.output.model_dump())
    if canonical(intent['arguments'])[0] != canonical(arguments)[0]:
        raise WorkConflict('command_arguments_changed')
    return command


def derive_action_operation(intent, **identity):
    command = action_command(intent)
    operation = derive_operation(command.model_dump(), **identity).model_dump()
    operation['intentDigest'] = canonical(intent)[1]
    return parse(DispatchOperation, operation)
