# UC-AGENT-002: Choose which model answers

## Behavior

A signed-in user can have the AI answered by a model of their own choice, with their own key, instead of by Notico's hosted model: through their OpenRouter account, which offers many models, or through their DeepSeek account, which offers DeepSeek's own models at DeepSeek's prices. These models usually use tools better than the hosted one; the user pays OpenRouter or DeepSeek for what they use, and spends no credits (see UC-CHAT-001).

The hosted model stays the default, so nothing needs setting up. From the settings page the user enters their key and picks a model. On OpenRouter, a few recommended ones come first, and any other that can use tools can be found by name; on DeepSeek, its models are listed. Each is shown with its price. The user can set up both, each with its own key, and switch between them without entering a key again. They can check that the key and the model work, and that the model can use tools, before they ask anything. The settings page always says which model answers.

The chat always shows which model answers, and the user can switch it there, between the hosted model and their own models on each service they set up, without leaving the chat; other models on OpenRouter are on the settings page. The user can switch at any time. The next question goes to the model chosen then, and the conversation goes on: it gets everything said and done so far. A question already running ends with the model it started with.

The choice and the key are kept on this device for the account that set them up: another account signed in on the same browser does not see or use them, and they are still there the next time the user opens the side panel. The user can remove either key; when it was the one in use, the hosted model answers again. A service that refuses a question says why: a key it rejects, a balance that ran out, or too many requests, which ends the question without trying again.

Key constraints:

- The user's own key leaves the device only in requests to the service it belongs to. It never reaches Notico's service, or the other service.
- A question answered by the user's own model spends no credits.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-AGENT-002-S01 | P0 | ✅ | Given a user who set up their own model on OpenRouter; when they ask a question that needs a tool; then their model is asked with their key, the AI uses the tool and answers, Notico's service never gets the key or the question, and no credits are spent. |
| UC-AGENT-002-S02 | P0 | ✅ | Given a user who set up their own model; when another account signs in on the same browser and asks something; then the hosted model answers, and that account cannot see the key. |
| UC-AGENT-002-S03 | P1 | ✅ | Given a user whose key OpenRouter rejects; when they ask something; then they are told the key was rejected. |
| UC-AGENT-002-S04 | P1 | ✅ | Given a user who set up their own model; when they remove their key and ask something; then the hosted model answers. |
| UC-AGENT-002-S05 | P1 | ✅ | Given a conversation with the hosted model; when the user switches to their own model and asks a follow-up; then their model answers it with the conversation so far, and the follow-up spends no credits. |
| UC-AGENT-002-S06 | P1 | ✅ | Given a user who set up their own model; when they open the side panel again later; then their own model still answers. |
| UC-AGENT-002-S07 | P1 | ✅ | Given a user setting up OpenRouter; when they look for a model by name; then they see only models that can use tools, each with its price, and can pick one. |
| UC-AGENT-002-S08 | P2 | ✅ | Given a user with a key and a model picked; when they check them; then they are told whether the model answered and whether it can use tools. |
| UC-AGENT-002-S10 | P1 | ✅ | Given a user with their own model set up; when they switch to another model from the chat and ask a follow-up; then that model answers it with the conversation so far, without the user leaving the chat. |
| UC-AGENT-002-S11 | P0 | ✅ | Given a user who set up a DeepSeek model with their DeepSeek key; when they ask a question that needs a tool; then DeepSeek is asked with their key, the AI uses the tool and answers, neither Notico's service nor OpenRouter gets the key or the question, and no credits are spent. |
| UC-AGENT-002-S12 | P1 | ✅ | Given a user who set up both OpenRouter and DeepSeek; when they switch from one to the other and back, from the settings page or the chat; then each question goes to the one chosen then, with its own key, and neither key has to be entered again. |
| UC-AGENT-002-S13 | P1 | ✅ | Given a user who saved a DeepSeek key; when they open the model menu in the chat; then DeepSeek's models are listed with their prices, and picking one has it answer the next question. |
| UC-AGENT-002-S14 | P1 | ✅ | Given a user whose DeepSeek key DeepSeek rejects, or whose DeepSeek balance ran out; when they ask something; then they are told which, and what to do about it. |
| UC-AGENT-002-S15 | P1 | ✅ | Given a user whose DeepSeek account is getting too many requests; when they ask something; then the question stops, they are told to wait, and nothing is sent again. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-AGENT-002-S09 | P0 | ✅ | Given a user who set up a recommended model on OpenRouter with a real key; when they ask about the open Notion page; then the model reads the page with a tool and answers from it. |
| UC-AGENT-002-S16 | P1 | ✅ | Given a user who set up a DeepSeek model with a real DeepSeek key; when they ask about the open Notion page; then the model reads the page with a tool and answers from it. |
