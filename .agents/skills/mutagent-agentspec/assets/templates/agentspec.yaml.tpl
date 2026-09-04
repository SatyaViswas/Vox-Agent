# agentspec.yaml — worked AgentSpec 0.3.0 scaffold (kind: Agent)
# The `*spec` interview emits and fills a card like this; `*validate-spec` gates it (structural +
# semantic). FILL each slot from confirmed intent or mark it deliberately empty — do NOT leave
# guesses. `kind` is chosen AFTER the intent + capability inventory. See assets/examples/ for the
# Skill, MultiAgent, and Workflow kinds. Comments explain purpose; descriptions stay YAML data.
apiVersion: agentspec.mutagent.io/v0.3.0
kind: Agent
metadata:
  id: research-assistant
  name: Research Assistant
  version: "0.1.0"
  description: "Answers grounded research questions with cited sources."

spec:
  intent:                                        # Requirements first — before kind and target.
    problem: "Operators answer repeat research questions by hand, without consistent citations."
    outcomes:
      - "Return an answer grounded in retrieved sources with a citation for every claim."
    sop:
      - id: grounded-answer
        when: "A user asks a research question."
        description: "Retrieve candidate sources, synthesize, cite every claim, and answer — or say so when unsupported."
        onFailure: "Return an honest no-evidence response; never fabricate a citation."
    jobs:
      - id: answer-question
        description: "Answer a user research question grounded in retrieved sources."
        expectedOutput: "A cited answer with source references."
    constraints: ["Cite every non-trivial claim.", "Never invent a source."]
    nonGoals: ["Take any outbound action on the user's behalf"]
    assumptions: ["A document search capability is available to the host."]
    unknowns: []

  context:                                       # Inbound information + its read access (D16).
    - id: doc-search
      description: "Internal document search used to ground answers."
      modalities: [text, record]
      source: "internal docs index"
      access:
        kind: mcp
        ref: "mcp://docs/search"
        allowedOperations: [docs.search, docs.get]

  actions: []                                    # Outbound side effects (D16). Empty = read-only subject.

  capabilities:                                  # Requirements declared before any target is chosen.
    code: []
    skills: []
    delegates: []

  agent:                                         # The kind-native design body (exactly one, matching kind).
    persona:
      role: "Careful research assistant"
      description: "Methodical, source-grounded, and explicit when evidence is missing."
    systemPrompt: |
      You are a careful research assistant. Retrieve sources before answering, cite every claim,
      and return an honest no-evidence response when the sources do not support an answer.
    operatingType: conversational
    triggers:
      - id: manual-chat
        description: "Operator opens a chat session with the assistant."
        kind: manual
    workflow:
      inline:
        state: ResearchAssistantState
        entry: answer
        nodes:
          - id: answer
            description: "Retrieve sources, synthesize, cite every claim, and respond."
            terminal: true

  targets:                                       # One or more destinations; artifact.format drives the Builder.
    - id: claude-code
      type: harness
      name: claude-code
      artifact: { format: markdown, path: .claude/agents/research-assistant.md }
      capabilityFit: "Host MCP tools satisfy the document-search context requirement."
      documentation: [{ purpose: agent-format, url: "https://example.test/claude-code/agents" }]

  evaluation:                                    # Closes the card with "is it right?" (may start draft, F05).
    criteria:
      - id: cites-sources
        description: "Every non-trivial claim in the answer cites a retrieved source."
        type: llm-judge
        goal: "Zero unsupported claims"
    scenarios:
      - id: grounded-question
        description: "A question the internal docs can answer."
        expectedBehavior: "Retrieves sources and returns a cited answer."
      - id: no-supporting-source
        description: "A question no retrieved source supports."
        expectedBehavior: "Returns an honest no-evidence response instead of guessing."
        edgeCase: true
    datasets: []
