import { Request, Response } from "express";

import Whatsapp from "../models/Whatsapp";
import { getIO } from "../libs/socket";
import { logger } from "../utils/logger";

import {
  handleMessage,
  handleMessageAck,
  ContactPayload,
  MessagePayload,
  WhatsappContextPayload
} from "../handlers/handleWhatsappEvents";
import { MessageType, MessageAck } from "../providers/WhatsApp/types";

// ---------------------------------------------------------------------------
// Types — Evolution API webhook payloads
// ---------------------------------------------------------------------------

interface EvoQRCodeEvent {
  event: "qrcode.updated";
  instance: string;
  data: {
    qrcode: {
      base64?: string;
      code?: string;
    };
  };
}

interface EvoConnectionEvent {
  event: "connection.update";
  instance: string;
  data: {
    state: "open" | "close" | "connecting";
    statusReason?: number;
  };
}

interface EvoMessageUpsertEvent {
  event: "messages.upsert";
  instance: string;
  data: {
    key: {
      remoteJid: string;
      fromMe: boolean;
      id: string;
      participant?: string;
    };
    pushName?: string;
    messageType: string;
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
      imageMessage?: { caption?: string; url?: string; mimetype?: string };
      videoMessage?: { caption?: string; url?: string; mimetype?: string };
      audioMessage?: { url?: string; mimetype?: string };
      documentMessage?: { caption?: string; url?: string; mimetype?: string; title?: string };
      stickerMessage?: { url?: string; mimetype?: string };
      locationMessage?: {
        degreesLatitude?: number;
        degreesLongitude?: number;
        name?: string;
      };
      contactMessage?: { vcard?: string };
      contactsArrayMessage?: { contacts?: Array<{ vcard?: string }> };
    };
    messageTimestamp?: number;
  };
}

interface EvoMessageAckEvent {
  event: "message.ack" | "messages.update" | "MESSAGE_ACK";
  instance: string;
  data: {
    key?: { id?: string };
    update?: { status?: number };
    status?: number;
    id?: string;
  };
}

type EvoWebhookEvent =
  | EvoQRCodeEvent
  | EvoConnectionEvent
  | EvoMessageUpsertEvent
  | EvoMessageAckEvent
  | { event: string; instance: string; data: unknown };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Instance name → whatsappId  (format: "whaticket-{id}") */
const resolveWhatsappId = async (instanceName: string): Promise<number | null> => {
  const whatsapp = await Whatsapp.findOne({ where: { name: instanceName } });
  if (whatsapp) return whatsapp.id;

  // Fallback: extract numeric suffix from "whaticket-{id}"
  const match = /whaticket-(\d+)$/.exec(instanceName);
  if (match) return Number(match[1]);

  logger.warn({ info: "WebhookController: could not resolve whatsappId", instanceName });
  return null;
};

const mapEvoType = (evoType?: string): MessageType => {
  const map: Record<string, MessageType> = {
    conversation: "chat",
    extendedTextMessage: "chat",
    imageMessage: "image",
    videoMessage: "video",
    audioMessage: "audio",
    audioOggOpusMessage: "audio",
    pttMessage: "ptt",
    documentMessage: "document",
    stickerMessage: "sticker",
    locationMessage: "location",
    contactMessage: "vcard",
    contactsArrayMessage: "vcard"
  };
  return map[evoType ?? ""] ?? "chat";
};

const extractBody = (data: EvoMessageUpsertEvent["data"]): string => {
  const msg = data.message;
  if (!msg) return "";

  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  if (msg.documentMessage?.caption) return msg.documentMessage.caption;
  if (msg.contactMessage?.vcard) return msg.contactMessage.vcard;
  if (msg.contactsArrayMessage?.contacts) {
    return msg.contactsArrayMessage.contacts.map(c => c.vcard ?? "").join("\n");
  }
  if (msg.locationMessage) {
    const loc = msg.locationMessage;
    const url = `https://maps.google.com/maps?q=${loc.degreesLatitude}%2C${loc.degreesLongitude}&z=17&hl=pt-BR`;
    return `${url}|${loc.name ?? `${loc.degreesLatitude}, ${loc.degreesLongitude}`}`;
  }
  return "";
};

const hasMediaType = (messageType: string): boolean => {
  return ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"].indexOf(messageType) !== -1;
};

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

const handleQRCode = async (event: EvoQRCodeEvent): Promise<void> => {
  const whatsappId = await resolveWhatsappId(event.instance);
  if (!whatsappId) return;

  const qr = event.data.qrcode?.base64 ?? event.data.qrcode?.code ?? "";
  if (!qr) return;

  const whatsapp = await Whatsapp.findByPk(whatsappId);
  if (!whatsapp) return;

  await whatsapp.update({ qrcode: qr, status: "qrcode" });

  const io = getIO();
  io.emit("whatsappSession", { action: "update", session: whatsapp });

  logger.info({ info: "Webhook: QR code received", instanceName: event.instance, whatsappId });
};

const handleConnectionUpdate = async (event: EvoConnectionEvent): Promise<void> => {
  const whatsappId = await resolveWhatsappId(event.instance);
  if (!whatsappId) return;

  const whatsapp = await Whatsapp.findByPk(whatsappId);
  if (!whatsapp) return;

  const io = getIO();
  const state = event.data.state;

  if (state === "open") {
    await whatsapp.update({ status: "CONNECTED", qrcode: "", retries: 0 });
    logger.info({ info: "Webhook: session connected", instanceName: event.instance, whatsappId });
  } else if (state === "close") {
    await whatsapp.update({ status: "DISCONNECTED" });
    logger.info({ info: "Webhook: session disconnected", instanceName: event.instance, whatsappId });
  } else if (state === "connecting") {
    await whatsapp.update({ status: "OPENING" });
  }

  const updated = await Whatsapp.findByPk(whatsappId);
  if (updated) {
    io.emit("whatsappSession", { action: "update", session: updated });
  }
};

const handleMessageUpsert = async (event: EvoMessageUpsertEvent): Promise<void> => {
  const whatsappId = await resolveWhatsappId(event.instance);
  if (!whatsappId) return;

  const { key, messageType, message, pushName, messageTimestamp } = event.data;
  const { remoteJid, fromMe, id, participant } = key;

  const isGroup = remoteJid.endsWith("@g.us");
  const body = extractBody(event.data);

  // Skip invisible characters at start (menu navigation messages)
  if (body && /\u200e/.test(body[0])) return;

  const type = mapEvoType(messageType);

  const messagePayload: MessagePayload = {
    id,
    body,
    fromMe,
    hasMedia: hasMediaType(messageType),
    type,
    timestamp: messageTimestamp ?? Math.floor(Date.now() / 1000),
    from: remoteJid,
    to: remoteJid,
    ack: fromMe ? 1 : 0
  };

  // For group messages the sender is in participant field
  const contactJid = !fromMe && isGroup && participant ? participant : remoteJid;
  const contactNumber = contactJid.replace(/@[a-z.]+$/, "");
  const groupNumber = isGroup ? remoteJid.replace(/@[a-z.]+$/, "") : "";

  const contactPayload: ContactPayload = {
    name: pushName ?? contactNumber,
    number: contactNumber,
    isGroup: false
  };

  let groupContactPayload: ContactPayload | undefined;
  if (isGroup) {
    groupContactPayload = {
      name: groupNumber,
      number: groupNumber,
      isGroup: true
    };
  }

  const contextPayload: WhatsappContextPayload = {
    whatsappId,
    unreadMessages: 0,
    groupContact: groupContactPayload
  };

  // Media: Evolution sends URL references — store mediaUrl on the payload
  // (user chose not to download to disk to preserve VPS storage)
  const mediaMsg = message as Record<string, { url?: string; mimetype?: string; title?: string } | undefined> | undefined;
  if (messagePayload.hasMedia && mediaMsg) {
    const mediaData = mediaMsg[messageType] as { url?: string; mimetype?: string; title?: string } | undefined;
    if (mediaData?.url) {
      messagePayload.mediaUrl = mediaData.url;
      messagePayload.mediaType = mediaData.mimetype?.split("/")[0];
    }
  }

  await handleMessage(messagePayload, contactPayload, contextPayload);
};

const handleAckUpdate = async (event: EvoMessageAckEvent): Promise<void> => {
  const messageId = event.data.key?.id ?? event.data.id;
  const status = event.data.update?.status ?? event.data.status;

  if (!messageId || status === undefined) return;

  let ack: MessageAck = 0;
  if (status >= 4) ack = 4;
  else if (status >= 3) ack = 3;
  else if (status >= 2) ack = 2;
  else if (status >= 1) ack = 1;

  await handleMessageAck(messageId, ack);
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const handle = async (req: Request, res: Response): Promise<void> => {
  // Respond immediately so Evolution doesn't retry
  res.status(200).json({ ok: true });

  const payload = req.body as EvoWebhookEvent;
  const event = payload?.event;

  if (!event) return;

  logger.debug({ info: "Webhook: event received", event, instance: payload.instance });

  try {
    if (event === "qrcode.updated") {
      await handleQRCode(payload as EvoQRCodeEvent);
    } else if (event === "connection.update") {
      await handleConnectionUpdate(payload as EvoConnectionEvent);
    } else if (event === "messages.upsert") {
      await handleMessageUpsert(payload as EvoMessageUpsertEvent);
    } else if (
      event === "message.ack" ||
      event === "MESSAGE_ACK" ||
      event === "messages.update"
    ) {
      await handleAckUpdate(payload as EvoMessageAckEvent);
    }
  } catch (err) {
    logger.error({ info: "WebhookController: error handling event", event, err });
  }
};

export default { handle };
