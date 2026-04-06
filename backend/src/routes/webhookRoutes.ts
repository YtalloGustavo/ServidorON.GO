import { Router } from "express";
import WebhookController from "../controllers/WebhookController";

const webhookRoutes = Router();

// Public route — no JWT auth required.
// Security is handled by Evolution API's apikey header validation
// and/or IP whitelist at the infrastructure level.
webhookRoutes.post("/evolution", WebhookController.handle);

export default webhookRoutes;
