# UC-NOTICO-AGENT-002: Choose which model answers

## Behavior

A signed-in user can have questions answered by a model of their own choice, through their own OpenRouter account and key, instead of by Cofun's hosted model (Auto, the default). Settings decides which providers and models are offered, and saves a key only after checking that it works; the composer's model menu picks which of them answers the next question, and the conversation carries on across a switch.

The user pays OpenRouter for their model and spends credits only on web pages rendered and web searches (UC-NOTICO-PANEL-003, UC-NOTICO-PANEL-004). Settings are kept on this device for the account that set them up.

Key constraints:

- The user's own key leaves the device only in requests to the provider it belongs to. It never reaches Cofun's service.
- A question answered by the user's own model spends no credits on its model calls; a web page rendered or a web search made for it costs credits as it does on the hosted model (UC-NOTICO-PANEL-003, UC-NOTICO-PANEL-004).
- Checking a key asks no model anything, so it costs nothing.

## Scenarios

### api-test

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-AGENT-002-S01 | P0 | ✅ | Given a user who turned OpenRouter on with their key and chose one of its models in the composer; when they ask a question that needs a tool, also after opening the side panel again; then their model is asked with their key, the AI uses the tool and answers, Cofun's service never gets the key or the question, and no credits are spent on the model. |
| UC-NOTICO-AGENT-002-S02 | P0 | ✅ | Given a user who set up their own model; when another account signs in on the same browser and asks something; then the hosted model answers, and that account cannot see the key. |
| UC-NOTICO-AGENT-002-S03 | P1 | ✅ | Given a user whose saved key OpenRouter now turns away; when they ask something; then they are told the key was turned away, and Settings marks OpenRouter "Key stopped working", with "Check again", which clears the mark once the key passes, and "Remove key", which deletes it from the device. |
| UC-NOTICO-AGENT-002-S25 | P1 | ✅ | Given a user whose OpenRouter account is getting too many requests; when they ask something; then the question stops, they are told why, and nothing is sent again. |
| UC-NOTICO-AGENT-002-S26 | P1 | ✅ | Given a user whose OpenRouter account has no credits left, or whose question the model's moderation on OpenRouter flags; when they ask something; then they are told which, with where to add credits when they ran out and OpenRouter's own words when flagged, and Settings still counts the key as working. |
| UC-NOTICO-AGENT-002-S04 | P1 | ✅ | Given a user who set up their own model; when they remove their key and ask something; then the hosted model answers. |
| UC-NOTICO-AGENT-002-S05 | P1 | ✅ | Given a conversation with the hosted model or the user's own; when they switch to another of their own models from the chat and ask a follow-up; then that model answers it with the conversation so far, without the user leaving the chat, and the follow-up spends no credits on the model. |
| UC-NOTICO-AGENT-002-S07 | P1 | ✅ | Given a user with OpenRouter on; when they look for a model by name; then they see the models that match, each with its price, those that can't use tools can't be switched on and say why, and one switched on joins the list and the composer's menu. |
| UC-NOTICO-AGENT-002-S08 | P0 | ✅ | Given a user who switches OpenRouter on and pastes a key OpenRouter accepts; when they check it; then the field and the button are locked while it runs, no model is asked anything, the key is saved, they are told it works with what it has left, and the first recommended model is switched on. |
| UC-NOTICO-AGENT-002-S19 | P0 | ✅ | Given a user checking a key; when the provider rejects it, says the account has no money left, doesn't answer within 15 seconds, or can't be reached; then the key is not saved, the field keeps what was pasted, and they are told which of these happened. |
| UC-NOTICO-AGENT-002-S18 | P1 | ✅ | Given a question the hosted model is answering with a tool; when the user switches to their own model before it ends; then the hosted model still answers that question, and the next question goes to their own model with the conversation so far. |
| UC-NOTICO-AGENT-002-S17 | P1 | ✅ | Given a user with OpenRouter on; when they open the composer's model menu; then Auto comes first, then each provider's name with its switched-on models by name only, without prices, payment, or key status, and "Manage models" opens Settings at the providers, where switching models on and off changes exactly what the menu offers, though a provider's last model on can't be switched off. |
| UC-NOTICO-AGENT-002-S21 | P1 | ✅ | Given a model chosen in the composer; when it is switched off in Settings; then the composer shows Auto and says in one line that the model was switched off, and the next question goes to Auto. |
| UC-NOTICO-AGENT-002-S23 | P1 | ✅ | Given a provider that is on with a saved key; when the user switches it off; then its models leave the menu but the key stays, and switching it on again offers them with no key to paste. |

### ai-e2e

| ID | Priority | Status | Scenario |
| --- | --- | --- | --- |
| UC-NOTICO-AGENT-002-S09 | P0 | ✅ | Given a real OpenRouter key; when the user checks it in Settings, chooses a recommended model, and asks about the open Notion page; then OpenRouter's key endpoint answers, the key is saved with what it has left where OpenRouter reports it, and the model reads the page with a tool and answers from it. |
