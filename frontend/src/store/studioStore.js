import { create } from "zustand";

export const useStudioStore = create((set) => ({
  prompt: "",
  setPrompt: (updater) =>
    set((state) => ({
      prompt: typeof updater === "function" ? updater(state.prompt) : updater,
    })),

  planning: false,
  setPlanning: (planning) => set({ planning }),
  planError: null,
  setPlanError: (planError) => set({ planError }),
  
  blueprint: null,
  setBlueprint: (blueprint) => set({ blueprint }),
  agentId: null,
  setAgentId: (agentId) => set({ agentId }),

  runStatus: "idle",
  setRunStatus: (runStatus) => set({ runStatus }),
  runError: null,
  setRunError: (runError) => set({ runError }),
  logs: [],
  setLogs: (logs) => set({ logs }),
  appendLog: (entry) =>
    set((state) => ({
      logs: [...state.logs, { ...entry, timestamp: new Date().toLocaleTimeString() }],
    })),
  stepStatuses: {},
  setStepStatuses: (updater) =>
    set((state) => ({
      stepStatuses: typeof updater === "function" ? updater(state.stepStatuses) : updater,
    })),

  disambigValues: {},
  setDisambigValues: (updater) =>
    set((state) => ({
      disambigValues: typeof updater === "function" ? updater(state.disambigValues) : updater,
    })),
  approved: false,
  setApproved: (approved) => set({ approved }),
  disambigResolved: false,
  setDisambigResolved: (disambigResolved) => set({ disambigResolved }),
  requiredAppsConnected: null,
  setRequiredAppsConnected: (requiredAppsConnected) => set({ requiredAppsConnected }),

  liveClarification: null,
  setLiveClarification: (liveClarification) => set({ liveClarification }),
  resuming: false,
  setResuming: (resuming) => set({ resuming }),
  resumeError: null,
  setResumeError: (resumeError) => set({ resumeError }),
  requireApproval: true,
  setRequireApproval: (requireApproval) => set({ requireApproval }),

  clearStudio: () =>
    set({
      prompt: "",
      planning: false,
      planError: null,
      blueprint: null,
      agentId: null,
      runStatus: "idle",
      runError: null,
      logs: [],
      stepStatuses: {},
      disambigValues: {},
      approved: false,
      disambigResolved: false,
      requiredAppsConnected: null,
      liveClarification: null,
      resuming: false,
      resumeError: null,
      requireApproval: true,
    }),
}));
