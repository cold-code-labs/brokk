import { z } from "zod";
export const codeReferenceSchema = z
  .object({
    path: z
      .string()
      .trim()
      .max(300)
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_./@()[\] -]*$/),
    line: z.number().int().min(1).max(1000000),
  })
  .strict();
export type CodeReference = z.infer<typeof codeReferenceSchema>;
export const insightSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4000),
    acceptance: z.string().trim().min(1).max(4000),
    noteIds: z.array(z.uuid()).min(1).max(100),
  })
  .strict();
export const analysisSchema = z
  .object({
    summary: z.string().trim().min(1).max(12000),
    proposals: z.array(insightSchema).max(50),
  })
  .strict();
export type CallAnalysis = z.infer<typeof analysisSchema>;
export type ReviewProposal = z.infer<typeof insightSchema> & {
  id: string;
  status: "pending" | "accepted" | "rejected";
  taskId: string;
  reviewedBy: string;
  codeReference?: CodeReference;
};
