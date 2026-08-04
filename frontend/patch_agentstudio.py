with open("src/pages/AgentStudio.jsx", "r") as f:
    content = f.read()

content = content.replace(
    'setRunError(err.message || "Failed to save or start the agent.");',
    'setRunError(`Failed to save or start: ${err.message || JSON.stringify(err)}`);\n      console.error("Save & Run Error:", err);'
)

with open("src/pages/AgentStudio.jsx", "w") as f:
    f.write(content)
