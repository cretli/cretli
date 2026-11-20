"""Stream one Z.ai chat completion through the official Python SDK."""

import json
import os
import sys

from zai import ZaiClient


def dump_model(value):
    if value is None:
        return None
    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True, exclude_none=True)
    return value


def main():
    request = json.load(sys.stdin)
    client = ZaiClient(
        api_key=os.environ["ZAI_API_KEY"],
        base_url=os.environ["ZAI_BASE_URL"],
        timeout=request.get("timeoutMs", 300000) / 1000,
        max_retries=0,
    )
    params = {
        "model": request["model"],
        "messages": request["messages"],
        "stream": True,
    }
    if request.get("tools"):
        params["tools"] = request["tools"]
    stream = client.chat.completions.create(**params)
    for chunk in stream:
        choices = getattr(chunk, "choices", None) or []
        usage = dump_model(getattr(chunk, "usage", None))
        if not choices:
            if usage:
                print(json.dumps({"usage": usage}), flush=True)
            continue
        choice = choices[0]
        delta = getattr(choice, "delta", None)
        tool_calls = []
        for position, call in enumerate(getattr(delta, "tool_calls", None) or []):
            function = getattr(call, "function", None)
            arguments = getattr(function, "arguments", None)
            if isinstance(arguments, dict):
                arguments = json.dumps(arguments, separators=(",", ":"))
            tool_calls.append({
                "index": getattr(call, "index", position),
                "id": getattr(call, "id", None),
                "function": {
                    "name": getattr(function, "name", None),
                    "arguments": arguments,
                },
            })
        result = {
            "deltaText": getattr(delta, "content", None) or "",
            "toolCallDeltas": tool_calls,
            "finishReason": getattr(choice, "finish_reason", None),
            "usage": usage,
        }
        print(json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}), flush=True)
        sys.exit(1)
