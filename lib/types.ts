export type SolutionStep = {
  title: string;
  explanation: string;
};

export type EasySection = {
  title: string;
  content: string;
};

export type LearningSolution = {
  subject: string;
  classLevel: string;
  difficulty: string;
  questionSummary: string;
  clue: string;
  approach: string;
  steps: SolutionStep[];
  diagramInstructions?: string;
  diagrams?: { id: string; storagePath: string; imageUrl: string; alt: string }[];
  diagramStatus?: "success" | "error" | "not_needed";
  veryEasy: {
    intro: string;
    sections: EasySection[];
    keyLesson: string;
    answer: string;
  };
};
