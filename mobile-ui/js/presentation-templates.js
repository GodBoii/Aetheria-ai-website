// js/presentation-templates.js
// Catalog of native PowerPoint templates and selection state helpers

export const PRESENTATION_TEMPLATES = {
  aetheria_modern: {
    id: "aetheria_modern",
    name: "Aetheria Modern",
    description: "Clean editorial deck for AI strategy and product narratives.",
    best_for: "AI strategy, product plans, operational reviews",
    colors: {
      bg: "#F5F6F0",
      surface: "#FFFFFF",
      ink: "#17202A",
      muted: "#5A6474",
      accent: "#1B5299",
      accent2: "#E8553D",
      accent3: "#1A936F"
    }
  },
  executive: {
    id: "executive",
    name: "Executive Boardroom",
    description: "Refined boardroom aesthetic with crisp data hierarchy.",
    best_for: "Business reviews, leadership updates, investor summaries",
    colors: {
      bg: "#FAF9F5",
      surface: "#FFFFFF",
      ink: "#111827",
      muted: "#5F6672",
      accent: "#0D6B5E",
      accent2: "#C2590A",
      accent3: "#1D5BBF"
    }
  },
  startup_pitch: {
    id: "startup_pitch",
    name: "Startup Pitch",
    description: "High-contrast dark deck with bold metrics for investors.",
    best_for: "Startup fundraising, product launches, market narratives",
    colors: {
      bg: "#0C1524",
      surface: "#162036",
      ink: "#F4F5F7",
      muted: "#B0BCCD",
      accent: "#60C3F7",
      accent2: "#F48FB1",
      accent3: "#81E6A9"
    }
  },
  academic: {
    id: "academic",
    name: "Academic Research",
    description: "Formal scholarly layout with readable evidence and citations.",
    best_for: "Research talks, coursework, technical explainers",
    colors: {
      bg: "#FFFFFF",
      surface: "#F0F4FA",
      ink: "#1E293B",
      muted: "#5C6B7F",
      accent: "#1749B8",
      accent2: "#6D28D9",
      accent3: "#047857"
    }
  },
  creative_portfolio: {
    id: "creative_portfolio",
    name: "Creative Portfolio",
    description: "Bold expressive deck with vibrant gradients and asymmetric layouts.",
    best_for: "Design portfolios, creative briefs, brand pitches",
    colors: {
      bg: "#1A1025",
      surface: "#261438",
      ink: "#F8F0FF",
      muted: "#C4A8E0",
      accent: "#FF6B6B",
      accent2: "#C084FC",
      accent3: "#4ADE80"
    }
  },
  minimal_zen: {
    id: "minimal_zen",
    name: "Minimal Zen",
    description: "Ultra-clean whitespace design with restrained single-accent palette.",
    best_for: "Thought leadership, keynotes, minimalist reports",
    colors: {
      bg: "#FAFAFA",
      surface: "#F4F4F5",
      ink: "#18181B",
      muted: "#71717A",
      accent: "#6366F1",
      accent2: "#A1A1AA",
      accent3: "#6366F1"
    }
  },
  tech_dark: {
    id: "tech_dark",
    name: "Tech Neon",
    description: "Dark engineering theme with electric neon accents and sharp edges.",
    best_for: "Technical demos, developer talks, product launches",
    colors: {
      bg: "#0A0E17",
      surface: "#121A28",
      ink: "#E8ECF2",
      muted: "#8899AA",
      accent: "#00E5FF",
      accent2: "#FF3D71",
      accent3: "#00E096"
    }
  },
  corporate_gradient: {
    id: "corporate_gradient",
    name: "Corporate Horizon",
    description: "Professional gradient-rich deck with structured visual hierarchy.",
    best_for: "Quarterly reports, all-hands meetings, client proposals",
    colors: {
      bg: "#F8FAFC",
      surface: "#FFFFFF",
      ink: "#0F172A",
      muted: "#5B6578",
      accent: "#0F4C81",
      accent2: "#E07A2F",
      accent3: "#2E8B57"
    }
  }
};

export function getSelectedPresentationTemplate() {
  const templateId = localStorage.getItem("aetheria:selected-presentation-template");
  return PRESENTATION_TEMPLATES[templateId] || null;
}

export function setSelectedPresentationTemplate(templateId) {
  const template = PRESENTATION_TEMPLATES[templateId];
  if (!template) {
    localStorage.removeItem("aetheria:selected-presentation-template");
    window.dispatchEvent(new CustomEvent("presentation-template:selected", { detail: { template: null } }));
    return null;
  }
  localStorage.setItem("aetheria:selected-presentation-template", template.id);
  window.dispatchEvent(new CustomEvent("presentation-template:selected", { detail: { template } }));
  return template;
}

export function clearSelectedPresentationTemplate() {
  localStorage.removeItem("aetheria:selected-presentation-template");
  window.dispatchEvent(new CustomEvent("presentation-template:selected", { detail: { template: null } }));
}

export function isPresentationRequest(message = '') {
  const text = String(message).toLowerCase();
  return /\b(ppt|pptx|powerpoint|slide\s*deck|presentation\s+deck|create\s+(?:a\s+)?presentation|make\s+(?:a\s+)?presentation)\b/.test(text);
}

export function buildPresentationTemplateInstruction(template) {
  if (!template) return '';
  return `\n\nIn order to create ppt, the user has specifically asked you to create the ppt using this "${template.name}" template.\nUse create_presentation with template="${template.id}". Do not choose a different presentation template unless the user explicitly changes it.`;
}
