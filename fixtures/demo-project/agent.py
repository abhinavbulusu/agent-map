"""
A deliberately naive weather agent: OpenAI chat completions + one HTTP tool.

It has the classic bug agentmap is built to expose: get_weather() passes the
API's response body straight to the model WITHOUT checking whether it actually
contains data. When the weather API returns an empty list, the model gets
nothing useful... and may answer confidently anyway.

Run it through agentmap (offline, against the mock LLM):
    node fixtures/mock-llm/server.ts                     # terminal 1
    cd fixtures/demo-project
    OPENAI_BASE_URL=http://127.0.0.1:4010/v1 OPENAI_API_KEY=fake \
        node ../../src/cli.ts run -- python3 agent.py    # terminal 2

Note what this file does NOT contain: any reference to agentmap. The openai
SDK reads OPENAI_BASE_URL from the environment, and `requests` honours
HTTP_PROXY — agentmap sets both, so the agent is observed without changes.
"""

import json
import os
import sys

import requests
from openai import OpenAI

WEATHER_API_URL = os.environ.get("WEATHER_API_URL", "http://127.0.0.1:4010/weather")
MODEL = os.environ.get("AGENT_MODEL", "gpt-4o-mini")

# The JSON Schema the model sees for our one tool.
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a city.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string", "description": "City name, e.g. Paris"}},
                "required": ["city"],
            },
        },
    }
]


def get_weather(city: str) -> str:
    resp = requests.get(WEATHER_API_URL, params={"city": city}, timeout=10)
    # BUG (on purpose): no status check, no "is there any data?" check.
    return resp.text


def main() -> None:
    question = " ".join(sys.argv[1:]) or "What's the weather in Paris right now?"
    client = OpenAI()  # reads OPENAI_API_KEY and OPENAI_BASE_URL from the environment

    messages = [
        {"role": "system", "content": "You are a helpful weather assistant. Use tools for live data."},
        {"role": "user", "content": question},
    ]

    for _ in range(5):  # hard cap on agent loop iterations
        response = client.chat.completions.create(model=MODEL, messages=messages, tools=TOOLS)
        message = response.choices[0].message

        if not message.tool_calls:
            print(message.content)
            return

        # Echo the assistant's tool-call message back, then append each result.
        messages.append(message.model_dump(exclude_none=True))
        for call in message.tool_calls:
            args = json.loads(call.function.arguments or "{}")
            result = get_weather(**args)
            messages.append({"role": "tool", "tool_call_id": call.id, "content": result})

    print("Gave up after 5 steps.")


if __name__ == "__main__":
    main()
