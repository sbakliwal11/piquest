import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeQuestion } from "@/lib/normalize";
import type { LearningSolution } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const diagramBucket = process.env.SUPABASE_DIAGRAM_BUCKET || "stepwise-diagrams";
const diagramModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5";
const diagramFailureMessage = "Here is the solution. There was some problem in generating the diagram. Please try again later if you want the diagram.";

function getAI() {
  if (!process.env.OPENAI_API_KEY) throw new Error("AI service is not configured yet. Please contact the app administrator.");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}


function getOpenAIForImages() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing from the server environment.");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

type SavedDiagram = { id: string; storagePath: string; imageUrl: string; alt: string };

function diagramInstructionState(instructions?: string): "needed" | "not_needed" | "invalid" {
  if (!instructions || !instructions.trim()) return "invalid";
  const tag = instructions.match(/<diagram_instructions\b([^>]*)>/i);
  if (!tag) return "invalid";
  if (/\bneeded\s*=\s*["']false["']/i.test(tag[1])) return "not_needed";
  if (/\bneeded\s*=\s*["']true["']/i.test(tag[1])) return "needed";
  return "invalid";
}

function diagramIsNeeded(instructions?: string): boolean {
  return diagramInstructionState(instructions) === "needed";
}

function makeDiagramPrompt(questionText: string, instructions: string): string {
  return `Create a clear, accurate educational diagram for a student solving the question below. Use the pseudo-XML as the authoritative specification. Produce only the diagram image, not a written answer or a page of explanation. Use a clean white background, neat textbook-style linework, readable labels, appropriate contrast, and uncluttered spacing. Preserve all specified symbols, values, units, directions, geometry, and scientific relationships. Do not invent extra quantities or relationships. For diagrams involving physics, ensure arrows, forces, rays, circuit connections, and angles match the specification. For mathematics, keep geometry and graph relationships mathematically consistent.

QUESTION:
${questionText}

PSEUDO-XML DIAGRAM SPECIFICATION:
${instructions}`;
}

async function ensureDiagramBucket(admin: SupabaseClient) {
  const { data, error } = await admin.storage.getBucket(diagramBucket);
  if (data && !error) return;
  const { error: createError } = await admin.storage.createBucket(diagramBucket, { public: true, fileSizeLimit: "10MB", allowedMimeTypes: ["image/png"] });
  if (createError && !/already exists|duplicate/i.test(createError.message)) {
    throw new Error(`Could not prepare diagram storage: ${createError.message}`);
  }
}

async function generateAndStoreDiagram(
  questionId: string,
  questionText: string,
  instructions: string,
  admin: SupabaseClient
): Promise<SavedDiagram> {
  if (!diagramIsNeeded(instructions)) throw new Error("Diagram instructions did not specify a required diagram.");
  if (!instructions.toLowerCase().includes("</diagram_instructions>") || !instructions.toLowerCase().includes("<purpose>")) {
    throw new Error("The model returned incomplete or malformed diagram XML.");
  }
  const openai = getOpenAIForImages();
  const imageResult = await openai.images.generate({
    model: diagramModel,
    prompt: makeDiagramPrompt(questionText, instructions),
    size: "1536x1024",
    quality: "high",
    output_format: "png",
    n: 1
  });
  const encodedImage = imageResult.data?.[0]?.b64_json;
  if (!encodedImage) throw new Error("The image model did not return an image.");
  const imageBytes = Buffer.from(encodedImage, "base64");
  if (imageBytes.length < 1000) throw new Error("The generated diagram image was empty or incomplete.");

  await ensureDiagramBucket(admin);
  const storagePath = `${questionId}/diagram1.png`;
  const { error: uploadError } = await admin.storage.from(diagramBucket).upload(storagePath, imageBytes, {
    contentType: "image/png",
    upsert: true,
    cacheControl: "31536000"
  });
  if (uploadError) throw new Error(`Could not save generated diagram: ${uploadError.message}`);
  const { data: publicData } = admin.storage.from(diagramBucket).getPublicUrl(storagePath);
  if (!publicData.publicUrl) throw new Error("Could not create a URL for the generated diagram.");
  return {
    id: "diagram1",
    storagePath,
    imageUrl: publicData.publicUrl,
    alt: `Educational diagram for: ${questionText.slice(0, 180)}`
  };
}

function getAdminClient() {
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing from the server environment.");
  return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

function cleanJson(text: string) {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

async function transcribeImage(ai: OpenAI, imageDataUrl: string): Promise<string> {
  const result = await ai.chat.completions.create({
    model,
    temperature: 0,
    max_completion_tokens: 1500,
    messages: [
      { role: "system", content: "You are a careful OCR assistant for Indian school Maths and Physics exam questions. Transcribe only the visible question exactly. Preserve equations, symbols, units, options, labels, and given values. Do not solve it. If a symbol is unclear, mark it as [unclear] instead of guessing." },
      { role: "user", content: [
        { type: "text", text: "Transcribe the full question from this image. Keep mathematical notation readable in plain text." },
        { type: "image_url", image_url: { url: imageDataUrl } }
      ] }
    ]
  });
  const text = result.choices[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("I couldn't read the question from that picture. Try a clearer photo or type the question.");
  return text.trim();
}


async function validateQuestionImage(ai: OpenAI, imageDataUrl: string): Promise<QuestionCheck> {
  const result = await ai.chat.completions.create({
    model,
    temperature: 0,
    max_completion_tokens: 350,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are the first-stage image checker for Stepwise, an app that accepts exactly ONE complete Maths or Physics question per image.
Inspect the image itself, not just any text extracted from it. Return only JSON with fields valid (boolean), reason, message.
reason must be one of: incomplete, multiple_questions, partial_images, unsupported_subject, not_a_question, unclear, ok.
Reject: non-Maths/Physics subject, unrelated photos, no readable question, multiple distinct questions, question visibly cut off, missing essential statement/data/diagram/options, or an image that appears to show only a fragment/continuation of a larger question.
Do not reject a complete Maths/Physics question merely because it has multiple lines, subparts (a)/(b) that are clearly one connected question, a diagram, or multiple equations.
If the photo contains several independent numbered questions, use multiple_questions.
If it appears to show only a continuation or cropped part, use partial_images or incomplete.
Use these concise friendly messages:
incomplete: "This question appears to be incomplete or cut off. Please upload a clear photo showing the entire question, including all given values, diagrams and answer choices."
multiple_questions: "This image appears to contain more than one question. Please upload one question at a time."
partial_images: "This looks like only part of a question. Please combine all parts into one complete image and upload it again."
unsupported_subject: "Stepwise currently supports Maths and Physics questions only. Please upload a question from either subject."
not_a_question: "I couldn't find a Maths or Physics question in this image. Please upload a clear photo of one complete question."
unclear: "I can't read the complete question clearly. Please take a sharper photo with the full question visible."
If one complete Maths/Physics question is clearly present, valid=true, reason=ok, message="". Never solve the question.`
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Check whether this image contains exactly one complete Maths or Physics question." },
          { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } }
        ]
      }
    ]
  });
  const raw = result.choices[0]?.message?.content;
  if (!raw) throw new Error("The image checker returned no result. Please try a clearer image.");
  type ImageCheckResponse = { valid?: unknown; reason?: unknown; message?: unknown };
  let parsed: ImageCheckResponse;
  try {
    const value: unknown = JSON.parse(cleanJson(raw));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Invalid image-check response");
    }
    parsed = value as ImageCheckResponse;
  } catch {
    throw new Error("I couldn't check this image reliably. Please upload a clearer image of one complete question.");
  }
  const reasons = ["incomplete", "multiple_questions", "partial_images", "unsupported_subject", "not_a_question", "unclear", "ok"] as const;
  type ImageIssue = typeof reasons[number];
  const reason: ImageIssue = typeof parsed.reason === "string" && (reasons as readonly string[]).includes(parsed.reason)
    ? (parsed.reason as ImageIssue)
    : "unclear";
  const defaults: Record<ImageIssue, string> = {
    ok: "",
    incomplete: "This question appears to be incomplete or cut off. Please upload a clear photo showing the entire question, including all given values, diagrams and answer choices.",
    multiple_questions: "This image appears to contain more than one question. Please upload one question at a time.",
    partial_images: "This looks like only part of a question. Please combine all parts into one complete image and upload it again.",
    unsupported_subject: "Stepwise currently supports Maths and Physics questions only. Please upload a question from either subject.",
    not_a_question: "I couldn't find a Maths or Physics question in this image. Please upload a clear photo of one complete question.",
    unclear: "I can't read the complete question clearly. Please take a sharper photo with the full question visible."
  };
  const valid = parsed.valid === true && reason === "ok";
  const finalReason: ImageIssue = valid ? "ok" : reason === "ok" ? "unclear" : reason;
  const message = valid ? "" : (typeof parsed.message === "string" && parsed.message.trim() ? parsed.message : (defaults[finalReason] || defaults.unclear));
  return { valid, reason: finalReason, message };
}

type QuestionCheck = {
  valid: boolean;
  reason: "incomplete" | "multiple_questions" | "partial_images" | "unsupported_subject" | "not_a_question" | "unclear" | "ok";
  message: string;
};

async function validateQuestion(ai: OpenAI, questionText: string): Promise<QuestionCheck> {
  const result = await ai.chat.completions.create({
    model,
    temperature: 0,
    max_completion_tokens: 500,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are Stepwise's input checker. This app only accepts one complete school-level Maths or Physics question.
Return JSON only: {"valid":boolean,"reason":"incomplete|multiple_questions|partial_images|unsupported_subject|not_a_question|unclear|ok","message":"short friendly message"}.
Rules:
- valid only when there is one complete, understandable Maths or Physics question.
- Reject a question that is visibly incomplete, missing essential text/data/diagram/options, or cut off.
- Reject multiple separate questions in one submission.
- Reject when the text indicates the user uploaded/sent separate fragments of one question; ask them to combine all parts into one clear image or provide the full text.
- Reject other subjects and non-question content.
- If unsure whether essential information is missing, reason=unclear and ask for a clearer/full question.
- Friendly concise messages, no technical jargon.
Suggested messages:
incomplete: "This question seems incomplete. Please upload a clear image showing the entire question, including any diagrams, values and answer choices, and upload the full question."
multiple_questions: "It looks like you’ve included more than one question. Please submit one question at a time so I can explain each one properly."
partial_images: "It looks like this question may be split across multiple images or missing a part. Please combine all parts into one complete image before submitting."
unsupported_subject: "Stepwise currently helps with Maths and Physics questions. Please submit one question from either subject."
not_a_question: "I couldn’t find a Maths or Physics question here. Please upload a clear photo of one complete question."
unclear: "I can’t confidently read the complete question. Please upload a clearer image and upload the full question."
For valid input, reason=ok and message="". Do not solve the question.`
      },
      { role: "user", content: `Check this submission:\n\n${questionText}` }
    ]
  });
  const raw = result.choices[0]?.message?.content;
  if (!raw) throw new Error("I couldn't check this question. Please try again.");
  const parsed = JSON.parse(cleanJson(raw));
  const allowed = new Set(["incomplete", "multiple_questions", "partial_images", "unsupported_subject", "not_a_question", "unclear", "ok"]);
  type QuestionIssue = "incomplete" | "multiple_questions" | "partial_images" | "unsupported_subject" | "not_a_question" | "unclear" | "ok";
  const reason: QuestionIssue = typeof parsed.reason === "string" && allowed.has(parsed.reason)
    ? (parsed.reason as QuestionIssue)
    : "unclear";
  const valid = parsed.valid === true && reason === "ok";
  const defaultMessages: Record<QuestionIssue, string> = {
    ok: "",
    incomplete: "This question seems incomplete. Please upload a clear image showing the entire question, including any diagrams, values and answer choices, and upload the full question.",
    multiple_questions: "It looks like you’ve included more than one question. Please submit one question at a time so I can explain each one properly.",
    partial_images: "It looks like this question may be split across multiple images or missing a part. Please combine all parts into one complete image before submitting.",
    unsupported_subject: "Stepwise currently helps with Maths and Physics questions. Please submit one question from either subject.",
    not_a_question: "I couldn’t find a Maths or Physics question here. Please upload a clear photo of one complete question.",
    unclear: "I can’t confidently read the complete question. Please upload a clearer image and upload the full question."
  };
  const finalReason: QuestionIssue = valid ? "ok" : reason === "ok" ? "unclear" : reason;
  const message = valid ? "" : (typeof parsed.message === "string" && parsed.message.trim() ? parsed.message : (defaultMessages[finalReason] || defaultMessages.unclear));
  return { valid, reason: finalReason, message };
}

const solutionInstructions = `
You are Stepwise, a learning-first Maths and Physics tutor for Indian students in Classes X, XI, XII and JEE/NEET preparation.
Help students learn the method, not merely copy an answer. Carefully solve and verify the question before writing explanations.
Return ONLY valid JSON with exactly these fields:
{
 "subject":"Maths or Physics or another short subject label",
 "classLevel":"estimated level such as Class XII / JEE-NEET",
 "difficulty":"Basic, Intermediate, Advanced, or JEE/NEET Advanced",
 "questionSummary":"one short sentence describing what is being asked",
 "clue":"short hint; state what the question asks and the first useful idea, do not reveal the final answer",
 "approach":"casual explanation like explaining to a friend; no calculations, no numbered steps, no long equations",
 "steps":[{"title":"logical step title","explanation":"markdown explanation for one meaningful reasoning stage"}],
 "veryEasy":{
   "intro":"friendly opening that states the idea simply",
   "sections":[{"title":"Step 1: ...","content":"markdown explanation; include formula logic, substitutions and calculations written on separate lines"}],
   "keyLesson":"one practical transferable lesson from the problem",
   "answer":"final answer and option if applicable"
 },
 "diagramInstructions":"A clean pseudo-XML string describing a diagram only if one is genuinely useful; otherwise use <diagram_instructions needed=\"false\">No diagram needed.</diagram_instructions>"
}
Rules:
- Use 3–8 logical steps where possible. Each step must represent a meaningful phase, not one line of algebra. Never exceed 9 steps unless the problem genuinely needs more.
- FORMATTING IS CRITICAL: In every step explanation, use short paragraphs and a blank line between distinct ideas. Put every logical action on its own line. Never write a dense paragraph that combines multiple actions.
- Every equation, substitution, simplification, and numerical calculation must be on its own separate line, with a blank line before or after it where helpful. Do not chain multiple equalities or calculation stages on one line.
- Use Markdown display math for standalone equations, with $$ on separate lines, for example:
  $$
  v = u + at
  $$
  Then put the substitution on a separate display-math block and the final arithmetic on another separate block.
- Keep explanations between equations short and explicit: say what we are doing and WHY before showing the calculation. Use numbered substeps or bullets inside a step when they improve clarity.
- Never show raw LaTeX commands as ordinary text. Use only $...$ for inline math and $$...$$ for display math because the app renderer parses dollar-delimited math. Do NOT use \\( ... \\) or \\[ ... \\] delimiters. Do not leave commands such as \\mathcal, \\frac, \\mu, \\Phi, or \\mathrm outside dollar-delimited math. Example: write $\\mathcal{E}=-\\frac{d\\Phi_B}{dt}$, not \\(\\mathcal{E}=-\\frac{d\\Phi_B}{dt}\\). If unsure, use readable plain text such as E = -dΦB/dt. Before returning JSON, check every field and replace any raw/unwrapped LaTeX with valid dollar-delimited math or plain text. For matrices, prefer a Markdown table or valid display math enclosed in $$...$$.
- End the final logical step with a clearly labelled **Final answer:**. State the answer in words where possible, include units, and explain what the value means in context. For matrix answers, display a readable matrix using a Markdown table or properly rendered display math, then state the result plainly in a sentence.
- In veryEasy sections, follow the same spacious formatting rules; never compact the solution.
- Very Easy should be one school level simpler than the estimated problem level. Explain WHY each formula is chosen and what it means. Use a simple analogy when helpful.
- Include the sign convention, units and assumptions when relevant. Do not invent missing information.
- The clue must not reveal the final answer. The approach should not contain calculations. The step-by-step mode must show calculations. End Very Easy with a key lesson.
- Do not claim a solution is certain if the question image/text is ambiguous. If needed, state what is unclear in questionSummary or clue.
- DIAGRAM INSTRUCTIONS ARE OPTIONAL AND MUST NEVER CHANGE OR SHORTEN THE ACTUAL SOLUTION. Complete and verify every normal solution field first.
- Add a final JSON string field named "diagramInstructions". This field is consumed by a separate OpenAI image-generation stage; return only the pseudo-XML instructions here and do not generate an image, SVG, canvas code, React code, or drawable JSON.
- If a diagram is not genuinely useful, set diagramInstructions exactly to: <diagram_instructions needed="false">No diagram needed.</diagram_instructions>
- If a diagram is useful, put clean pseudo-XML in diagramInstructions using this structure: <diagram_instructions needed="true"><purpose>...</purpose><diagram_type>...</diagram_type><canvas width="..." height="..." units="px"/><elements><element id="..." type="..." label="..."/><element id="..." type="..." label="..."/></elements><layout>Describe relative positions, direction, scale, spacing and grouping.</layout><labels>List exact text, symbols, values and units to show.</labels><relationships>Describe connections, arrows, ordering, angles, forces, circuit connections or other relationships.</relationships><accuracy_constraints>State what must be mathematically or scientifically accurate and what must not be invented.</accuracy_constraints></diagram_instructions>. Adapt the elements to the actual question; include only relevant tags and specific details. Escape XML special characters if needed. No Markdown fences inside the XML.
- The diagramInstructions field must be a JSON string containing the pseudo-XML, with quotes escaped as required for valid JSON. Do not wrap the XML in a Markdown code fence.
- Output valid JSON, no markdown code fences.
`;

async function generateSolution(ai: OpenAI, questionText: string): Promise<LearningSolution> {
  const result = await ai.chat.completions.create({
    model,
    temperature: 0.2,
    max_completion_tokens: 6500,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: solutionInstructions },
      { role: "user", content: `Solve and teach this question:\n\n${questionText}` }
    ]
  });
  const raw = result.choices[0]?.message?.content;
  if (!raw) throw new Error("The AI returned an empty solution. Please try again.");
  const parsed = JSON.parse(cleanJson(raw));
  if (!parsed.clue || !parsed.approach || !Array.isArray(parsed.steps) || !parsed.veryEasy?.sections) {
    throw new Error("The generated solution was incomplete. Please submit the question again.");
  }
  parsed.steps = parsed.steps.slice(0, 9);
  return parsed as LearningSolution;
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return NextResponse.json({ error: "Please log in to solve and save questions." }, { status: 401 });

    if (!supabaseUrl || !publishableKey) {
      throw new Error("Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local.");
    }

    const userClient = createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    if (authError || !authData.user) return NextResponse.json({ error: "Your session expired. Please log in again." }, { status: 401 });

    const body = await request.json();
    const imageDataUrl = typeof body.imageDataUrl === "string" ? body.imageDataUrl : "";

    if (!imageDataUrl) {
      return NextResponse.json({ error: "Please upload a clear image of one complete Maths or Physics question." }, { status: 400 });
    }
    if (imageDataUrl.length > 7_000_000) {
      return NextResponse.json({ error: "Please upload an image smaller than 5 MB." }, { status: 413 });
    }
    const supportedImageFormat = /^data:image\/(png|jpe?g|webp);base64,/i.test(imageDataUrl);
    if (!supportedImageFormat) {
      return NextResponse.json(
        { error: "This image format isn't supported. Please use JPG, PNG or WEBP." },
        { status: 415 }
      );
    }

    const ai = getAI();

    // Inspect the actual image before OCR/solving, so invalid submissions get a friendly message.
    const imageCheck = await validateQuestionImage(ai, imageDataUrl);
    if (!imageCheck.valid) {
      return NextResponse.json({ error: imageCheck.message, inputIssue: imageCheck.reason }, { status: 422 });
    }

    const questionText = await transcribeImage(ai, imageDataUrl);
    if (!questionText.trim()) {
      return NextResponse.json({ error: "I couldn't read a question from this image. Please upload a sharper photo showing the entire question." }, { status: 422 });
    }

    const questionCheck = await validateQuestion(ai, questionText);
    if (!questionCheck.valid) {
      return NextResponse.json({ error: questionCheck.message, inputIssue: questionCheck.reason }, { status: 422 });
    }

    const normalized = normalizeQuestion(questionText);
    const { data: existing, error: lookupError } = await userClient
      .from("question_bank")
      .select("id, question_text, solution, subject, difficulty")
      .eq("normalized_question", normalized)
      .maybeSingle();

    if (lookupError) throw new Error("Database lookup failed. Check the Supabase SQL setup and RLS policies.");
    let solution: LearningSolution;
    let questionId: string;
    let savedQuestionText = questionText;
    let cached = false;
    let diagramError = false;
    let admin: SupabaseClient | null = null;

    if (existing) {
      solution = existing.solution as LearningSolution;
      questionId = existing.id;
      savedQuestionText = existing.question_text;
      cached = true;
    } else {
      solution = await generateSolution(ai, questionText);
      // Saving the core solution is required; image generation is a separate optional stage.
      admin = getAdminClient();
      const { data: inserted, error: insertError } = await admin
        .from("question_bank")
        .upsert({
          normalized_question: normalized,
          question_text: questionText,
          solution,
          subject: solution.subject || "Unknown",
          difficulty: solution.difficulty || "Unknown"
        }, { onConflict: "normalized_question" })
        .select("id, question_text, solution")
        .single();
      if (insertError || !inserted) {
        throw new Error("The solution was generated but could not be saved to the question bank. Check the server-only Supabase service key.");
      }
      questionId = inserted.id;
      savedQuestionText = inserted.question_text;
      solution = inserted.solution as LearningSolution;
    }

    const instructionState = diagramInstructionState(solution.diagramInstructions);
    const savedDiagrams = Array.isArray(solution.diagrams) ? solution.diagrams : [];
    const invalidInstructionsShouldBeReported = instructionState === "invalid" && (!cached || Boolean(solution.diagramInstructions?.trim()));
    if (invalidInstructionsShouldBeReported) {
      diagramError = true;
      solution = { ...solution, diagrams: [], diagramStatus: "error" } as LearningSolution;
      if (admin) {
        const { error: updateError } = await admin.from("question_bank").update({ solution }).eq("id", questionId);
        if (updateError) console.error("Could not save missing diagram XML status:", updateError.message);
      }
      console.error("The text model returned missing or malformed diagram instructions; preserving the solution.");
    } else if (instructionState === "needed" && savedDiagrams.length === 0) {
      try {
        if (!admin) admin = getAdminClient();
        const diagram = await generateAndStoreDiagram(questionId, savedQuestionText, solution.diagramInstructions || "", admin);
        solution = { ...solution, diagrams: [diagram], diagramStatus: "success" } as LearningSolution;
        const { error: updateError } = await admin
          .from("question_bank")
          .update({ solution })
          .eq("id", questionId);
        if (updateError) throw new Error(`Could not save diagram metadata: ${updateError.message}`);
      } catch (diagramGenerationError: unknown) {
        diagramError = true;
        solution = { ...solution, diagrams: [], diagramStatus: "error" } as LearningSolution;
        // Keep the solution available even if image generation/storage fails. Cache the status
        // so it can be retried on the next request rather than failing the solution request.
        if (admin) {
          const { error: updateError } = await admin
            .from("question_bank")
            .update({ solution })
            .eq("id", questionId);
          if (updateError) console.error("Could not save diagram failure status:", updateError.message);
        }
        console.error("Stepwise diagram generation failed (solution remains available):", diagramGenerationError);
      }
    }

    const { error: historyError } = await userClient.from("question_history").insert({
      user_id: authData.user.id,
      question_bank_id: questionId,
      question_text: savedQuestionText,
      subject: solution.subject || "Unknown",
      difficulty: solution.difficulty || "Unknown",
      solution_snapshot: solution
    });
    if (historyError) {
      // A question can still be shown if history saving fails, but report it in server logs.
      console.error("Could not save question history:", historyError.message);
    }

    return NextResponse.json({ questionText: savedQuestionText, solution, cached, diagramError, diagramErrorMessage: diagramError ? diagramFailureMessage : null });
  } catch (error: unknown) {
    console.error("Stepwise /api/solve error:", error);
    const rawMessage = error instanceof Error ? error.message : "";
    const lowerMessage = rawMessage.toLowerCase();
    let message = "We couldn't process this question right now. Please try again with a clearer image.";
    let status = 500;
    if (lowerMessage.includes("rate limit") || lowerMessage.includes("429") || lowerMessage.includes("quota")) {
      message = "Stepwise is receiving too many AI requests right now. Please wait a minute and try again.";
      status = 429;
    } else if (lowerMessage.includes("model_not_found") || lowerMessage.includes("model does not exist") || lowerMessage.includes("do not have access to model") || lowerMessage.includes("unsupported model")) {
      message = `The configured AI model ("${model}") is unavailable for this API key. Set OPENAI_MODEL in .env.local to a model enabled for your OpenAI account.`;
      status = 503;
    } else if (lowerMessage.includes("api_key") || lowerMessage.includes("not configured") || lowerMessage.includes("authentication") || lowerMessage.includes("401")) {
      message = "The AI service is not configured correctly. Please contact the app administrator.";
      status = 503;
    } else if (lowerMessage.includes("timeout") || lowerMessage.includes("timed out") || lowerMessage.includes("econnreset")) {
      message = "The request took too long or the connection was interrupted. Please try again.";
      status = 504;
    } else if (lowerMessage.includes("couldn't read") || lowerMessage.includes("could not read") || lowerMessage.includes("unclear")) {
      message = "We couldn't clearly read the question. Please take a brighter, sharper photo with the full question visible.";
      status = 422;
    } else if (lowerMessage.includes("json") || lowerMessage.includes("incomplete solution") || lowerMessage.includes("empty solution")) {
      message = "The solution wasn't completed properly. Please try again; if it keeps happening, use a clearer photo of just one question.";
      status = 502;
    }
    return NextResponse.json({ error: message }, { status });
  }
}
