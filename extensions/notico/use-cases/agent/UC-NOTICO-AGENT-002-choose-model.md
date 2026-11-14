# UC-NOTICO-AGENT-002: Choose which model answers

## Behavior

A signed-in user can have the AI answered by a model of their own choice, with their own key, instead of by Notico's hosted model: through their OpenRouter account, which offers many models, or through their DeepSeek account, which offers DeepSeek's own models at DeepSeek's prices. These models usually use tools better than the hosted one; the user pays OpenRouter or DeepSeek for what they use, and spends no credits (see UC-NOTICO-CHAT-001).

Two places do two jobs. **Settings decides where models come from**: which providers are on, their keys, and which of their models to offer. **The composer's model menu decides which of those answers** the next question.

**Providers in Settings.** Providers are switches, and any number can be on. Notico is always on, needs no key, spends credits, and offers Auto, the hosted model, which stays the default, so nothing needs setting up. OpenRouter and DeepSeek each need the user's key: switching one on opens its key field.

**The key is checked before it is saved.** Checking asks the provider whether the key works, through the provider's own account endpoint, which is free and asks no model anything. While the check runs, the field and the button are locked, and the check gives up after about 15 seconds. Only a key that passes is saved; the provider then says the key works, with the balance where the provider reports one, and shows its models, the first recommended one switched on so the provider is usable at once. A key that fails is not saved, and the user is told which of these happened: the provider rejected the key, the account has no money left, the check timed out, or the provider couldn't be reached. What was pasted stays in the field, so it can be fixed.

**Models under each provider.** Each provider that is on lists its models, each with a switch and its price per million tokens. OpenRouter shows a few recommended models and a search over its whole list; a model found there that is switched on joins the list. Models that can't use tools can't be switched on, and say why. DeepSeek lists all of its models. At least one model stays on for each provider that is on.

**The composer's model menu** lists Auto first, on its own, then each provider that is on, under its name, with its switched-on models by name only: who pays and the state of the key are not shown there. "Manage models" opens Settings at the providers. The user can switch at any time, without leaving the chat. The next question goes to the model chosen then, and the conversation goes on: it gets everything said and done so far. A question already running ends with the model it started with. When the model chosen in the composer is no longer offered (switched off in Settings, its provider switched off, or its key removed), questions go to Auto, and the composer says so in one line instead of switching silently.

**A key that stops working.** A provider that refuses a question says why: a key it turns away, a balance that ran out, or too many requests, which ends the question without trying again. When a question is turned away for its key, Settings also marks the provider "Key stopped working", with "Check again" and "Remove key".

Settings are kept on this device for the account that set them up: another account signed in on the same browser does not see or use them, and they are still there the next time the user opens the side panel. Switching a provider off keeps its key, so switching it back on needs no paste. "Remove key" deletes it.

Key constraints:

- The user's own key leaves the device only in requests to the provider it belongs to. It never reaches Notico's service, or the other provider.
- A question answered by the user's own model spends no credits.
- Checking a key asks no model anything, so it costs nothing.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-AGENT-002-S01 | P0 | ✅ | Given a user who turned OpenRouter on with their key and chose one of its models in the composer; when they ask a question that needs a tool; then their model is asked with their key, the AI uses the tool and answers, Notico's service never gets the key or the question, and no credits are spent. |
| UC-NOTICO-AGENT-002-S02 | P0 | ✅ | Given a user who set up their own model; when another account signs in on the same browser and asks something; then the hosted model answers, and that account cannot see the key. |
| UC-NOTICO-AGENT-002-S03 | P1 | ✅ | Given a user whose saved key OpenRouter now turns away; when they ask something; then they are told the key was turned away, and Settings marks OpenRouter "Key stopped working", with "Check again" and "Remove key". |
| UC-NOTICO-AGENT-002-S04 | P1 | ✅ | Given a user who set up their own model; when they remove their key and ask something; then the hosted model answers. |
| UC-NOTICO-AGENT-002-S05 | P1 | ✅ | Given a conversation with the hosted model; when the user switches to their own model and asks a follow-up; then their model answers it with the conversation so far, and the follow-up spends no credits. |
| UC-NOTICO-AGENT-002-S06 | P1 | ✅ | Given a user who set up their own model; when they open the side panel again later; then their own model still answers. |
| UC-NOTICO-AGENT-002-S07 | P1 | ✅ | Given a user with OpenRouter on; when they look for a model by name; then they see the models that match, each with its price, those that can't use tools can't be switched on and say why, and one switched on joins the list and the composer's menu. |
| UC-NOTICO-AGENT-002-S08 | P0 | ✅ | Given a user who switches OpenRouter on and pastes a key OpenRouter accepts; when they check it; then the field and the button are locked while it runs, no model is asked anything, the key is saved, they are told it works with what it has left, and the first recommended model is switched on. |
| UC-NOTICO-AGENT-002-S19 | P0 | ✅ | Given a user checking a key; when the provider rejects it, says the account has no money left, doesn't answer within 15 seconds, or can't be reached; then the key is not saved, the field keeps what was pasted, and they are told which of these happened. |
| UC-NOTICO-AGENT-002-S10 | P1 | ✅ | Given a user with their own model set up; when they switch to another model from the chat and ask a follow-up; then that model answers it with the conversation so far, without the user leaving the chat. |
| UC-NOTICO-AGENT-002-S11 | P0 | ✅ | Given a user who turned DeepSeek on with their DeepSeek key and chose a DeepSeek model; when they ask a question that needs a tool; then DeepSeek is asked with their key, the AI uses the tool and answers, neither Notico's service nor OpenRouter gets the key or the question, and no credits are spent. |
| UC-NOTICO-AGENT-002-S12 | P1 | ✅ | Given a user with both OpenRouter and DeepSeek on; when they switch from one to the other and back in the composer; then each question goes to the one chosen then, with its own key, and neither key has to be entered again. |
| UC-NOTICO-AGENT-002-S14 | P1 | ✅ | Given a user whose DeepSeek key DeepSeek rejects, or whose DeepSeek balance ran out; when they ask something; then they are told which, and what to do about it. |
| UC-NOTICO-AGENT-002-S15 | P1 | ✅ | Given a user whose DeepSeek account is getting too many requests; when they ask something; then the question stops, they are told to wait, and nothing is sent again. |
| UC-NOTICO-AGENT-002-S18 | P1 | ✅ | Given a question the hosted model is answering with a tool; when the user switches to their own model before it ends; then the hosted model still answers that question, and the next question goes to their own model with the conversation so far. |
| UC-NOTICO-AGENT-002-S17 | P1 | ✅ | Given a user with OpenRouter and DeepSeek on; when they open the composer's model menu; then Auto comes first, then each provider's name with its switched-on models by name only, without prices, payment, or key status, and "Manage models" opens Settings at the providers. |
| UC-NOTICO-AGENT-002-S20 | P1 | ✅ | Given a provider that is on; when the user switches its models on and off; then the menu offers exactly the models that are on, and the provider's last model on can't be switched off. |
| UC-NOTICO-AGENT-002-S21 | P1 | ✅ | Given a model chosen in the composer; when it is switched off in Settings; then the composer shows Auto and says in one line that the model was switched off, and the next question goes to Auto. |
| UC-NOTICO-AGENT-002-S22 | P1 | ✅ | Given a provider marked "Key stopped working"; when the user checks the key again and it passes, or removes it; then the mark goes, or the key is deleted from the device. |
| UC-NOTICO-AGENT-002-S23 | P1 | ✅ | Given a provider that is on with a saved key; when the user switches it off; then its models leave the menu but the key stays, and switching it on again offers them with no key to paste. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-AGENT-002-S09 | P0 | ✅ | Given a user who turned OpenRouter on with a real key and chose a recommended model; when they ask about the open Notion page; then the model reads the page with a tool and answers from it. |
| UC-NOTICO-AGENT-002-S16 | P1 | ✅ | Given a user who turned DeepSeek on with a real DeepSeek key and chose a DeepSeek model; when they ask about the open Notion page; then the model reads the page with a tool and answers from it. |
| UC-NOTICO-AGENT-002-S24 | P1 | 🚧 | Given a real OpenRouter or DeepSeek key; when the user checks it in Settings; then the provider's account endpoint answers, the key is saved, and the balance shows where the provider reports one. |
