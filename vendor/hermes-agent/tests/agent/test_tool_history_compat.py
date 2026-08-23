from agent.conversation_loop import _flatten_completed_tool_history_for_compat


def test_flattens_completed_tool_exchange_without_losing_real_result():
    messages = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "remember this"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": {"name": "memory", "arguments": "{}"},
            }],
        },
        {
            "role": "tool",
            "name": "memory",
            "tool_call_id": "call-1",
            "content": '{"success":true,"done":true}',
        },
    ]

    assert _flatten_completed_tool_history_for_compat(messages) is True
    assert [message["role"] for message in messages] == [
        "system", "user", "assistant", "user"
    ]
    assert messages[2] == {
        "role": "assistant",
        "content": "[Completed tool call: memory]",
    }
    assert "success" in messages[3]["content"]
    assert all("tool_calls" not in message for message in messages)
    assert all("tool_call_id" not in message for message in messages)


def test_merges_parallel_tool_results_into_one_user_turn():
    messages = [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"function": {"name": "first"}},
                {"function": {"name": "second"}},
            ],
        },
        {"role": "tool", "name": "first", "content": "one"},
        {"role": "tool", "name": "second", "content": {"value": 2}},
    ]

    assert _flatten_completed_tool_history_for_compat(messages) is True
    assert [message["role"] for message in messages] == ["assistant", "user"]
    assert "first, second" in messages[0]["content"]
    assert "one" in messages[1]["content"]
    assert '"value": 2' in messages[1]["content"]


def test_leaves_plain_chat_unchanged():
    messages = [{"role": "user", "content": "hello"}]
    original = list(messages)
    assert _flatten_completed_tool_history_for_compat(messages) is False
    assert messages == original
