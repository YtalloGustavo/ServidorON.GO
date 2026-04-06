import fs from "fs";
import axios, { AxiosInstance } from "axios";

import Whatsapp from "../../../models/Whatsapp";
import { getIO } from "../../../libs/socket";
import { logger } from "../../../utils/logger";
import AppError from "../../../errors/AppError";

import {
  ProviderMessage,
  ProviderMediaInput,
  ProviderContact,
  SendMessageOptions,
  SendMediaOptions,
  MessageType
} from "../types";
import { WhatsappProvider } from "../whatsappProvider";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "http://localhost:8080";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";
const BACKEND_URL = process.env.BACKEND_URL || "";

// Instance name template — keeps names stable and unique per whatsappId
const instanceName = (whatsappId: number): string => `whaticket-${whatsappId}`;

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

const createClient = (): AxiosInstance =>
  axios.create({
    baseURL: EVOLUTION_API_URL,
    headers: {
      apikey: EVOLUTION_API_KEY,
      "Content-Type": "application/json"
    },
    timeout: 30_000
  });

// Lazy singleton — avoid creating on module load so env vars are resolved
let _client: AxiosInstance | null = null;
const client = (): AxiosInstance => {
  if (!_client) _client = createClient();
  return _client;
};

// ---------------------------------------------------------------------------
// Types — Evolution API shapes
// ---------------------------------------------------------------------------

interface EvoContact {
  id: string;
  pushName?: string;
  profilePictureUrl?: string;
}

interface EvoCheckNumberResult {
  exists: boolean;
  jid: string;
}

interface EvoSentMessage {
  key: {
    id: string;
    remoteJid: string;
    fromMe: boolean;
  };
  messageTimestamp?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maps Evolution messageType strings to the internal MessageType union.
 */
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

/**
 * Converts an Evolution sent-message response to the internal ProviderMessage.
 */
const toProviderMessage = (
  sent: EvoSentMessage,
  body: string,
  hasMedia: boolean,
  type: MessageType
): ProviderMessage => ({
  id: sent.key.id,
  body,
  fromMe: true,
  hasMedia,
  type,
  timestamp: sent.messageTimestamp ?? Math.floor(Date.now() / 1000),
  from: sent.key.remoteJid,
  to: sent.key.remoteJid,
  ack: 1
});

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/** Initialise (or re-connect) a session in the Evolution API. */
const init = async (whatsapp: Whatsapp): Promise<void> => {
  const io = getIO();
  const name = instanceName(whatsapp.id);

  // POST /instance/create — idempotent; Evolution returns 409 if exists
  try {
    await client().post("/instance/create", {
      instanceName: name,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
      // Register our webhook so Evolution pushes events to us
      webhook: {
        enabled: true,
        url: `${BACKEND_URL}/webhook/evolution`,
        events: [
          "QRCODE_UPDATED",
          "CONNECTION_UPDATE",
          "MESSAGES_UPSERT",
          "MESSAGES_UPDATE",
          "MESSAGE_ACK"
        ],
        webhook_by_events: false,
        webhook_base64: false // we want URLs, not base64 for media
      }
    });
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      // Instance already exists — that's fine, just connect
      logger.info({ info: "Evolution instance already exists, reconnecting", name });
    } else {
      logger.error({ info: "Error creating Evolution instance", name, err });
      throw new AppError("ERR_EVOLUTION_CREATE_INSTANCE");
    }
  }

  // POST /instance/connect/{instance}
  try {
    const { data } = await client().get<{ base64?: string; code?: string }>(
      `/instance/connect/${name}`
    );

    // QR code comes as base64 image — store it and emit to frontend
    const qrBase64 = data?.base64 ?? data?.code ?? "";
    if (qrBase64) {
      await whatsapp.update({ qrcode: qrBase64, status: "qrcode" });
      io.emit("whatsappSession", { action: "update", session: whatsapp });
      logger.info({ info: "Evolution QR code generated", instanceName: name });
    }
  } catch (err: unknown) {
    logger.error({ info: "Error connecting Evolution instance", name, err });
    throw new AppError("ERR_EVOLUTION_CONNECT_INSTANCE");
  }
};

/** Remove the in-memory session (no-op for Evolution — state lives on API side). */
const removeSession = (_whatsappId: number): void => {
  // Evolution API manages state server-side; nothing to clean locally
};

/** Logout and delete the Evolution instance. */
const logout = async (sessionId: number): Promise<void> => {
  const name = instanceName(sessionId);

  try {
    await client().delete(`/instance/logout/${name}`);
  } catch (err) {
    logger.warn({ info: "Evolution logout failed (may already be disconnected)", name, err });
  }

  try {
    await client().delete(`/instance/delete/${name}`);
  } catch (err) {
    logger.warn({ info: "Evolution delete failed", name, err });
  }

  const whatsapp = await Whatsapp.findByPk(sessionId);
  if (whatsapp) {
    await whatsapp.update({ status: "DISCONNECTED", qrcode: "", session: "", retries: 0 });
    const io = getIO();
    io.emit("whatsappSession", { action: "update", session: whatsapp });
  }
};

/** Send a text message. */
const sendMessage = async (
  sessionId: number,
  to: string,
  body: string,
  options?: SendMessageOptions
): Promise<ProviderMessage> => {
  const name = instanceName(sessionId);
  // Strip @c.us / @s.whatsapp.net suffixes — Evolution expects plain numbers or @s.whatsapp.net
  const number = to.replace(/@[csg]\.us$/i, "").replace(/@s\.whatsapp\.net$/i, "");

  try {
    const payload: Record<string, unknown> = {
      number,
      text: body
    };

    if (options?.quotedMessageId) {
      payload.quoted = { key: { id: options.quotedMessageId } };
    }

    const { data } = await client().post<EvoSentMessage>(
      `/message/sendText/${name}`,
      payload
    );

    return toProviderMessage(data, body, false, "chat");
  } catch (err) {
    logger.error({ info: "Evolution sendMessage error", sessionId, to, err });
    throw new AppError("ERR_SENDING_WAPP_MSG");
  }
};

/** Send a media message (file from disk path or Buffer). */
const sendMedia = async (
  sessionId: number,
  to: string,
  media: ProviderMediaInput,
  options?: SendMediaOptions
): Promise<ProviderMessage> => {
  const name = instanceName(sessionId);
  const number = to.replace(/@[csg]\.us$/i, "").replace(/@s\.whatsapp\.net$/i, "");

  try {
    // Build base64 data if we have a Buffer, otherwise rely on path
    let mediaBase64: string | undefined;
    if (media.data) {
      mediaBase64 = media.data.toString("base64");
    } else if (media.path) {
      mediaBase64 = fs.readFileSync(media.path).toString("base64");
    }

    if (!mediaBase64) {
      throw new AppError("ERR_NO_MEDIA_DATA");
    }

    const mimeCategory = media.mimetype.split("/")[0]; // image | video | audio | application
    const mediaType: "image" | "video" | "audio" | "document" =
      mimeCategory === "image"
        ? "image"
        : mimeCategory === "video"
        ? "video"
        : mimeCategory === "audio"
        ? "audio"
        : "document";

    const payload: Record<string, unknown> = {
      number,
      mediatype: mediaType,
      mimetype: media.mimetype,
      caption: options?.caption ?? "",
      fileName: media.filename,
      media: mediaBase64
    };

    if (options?.quotedMessageId) {
      payload.quoted = { key: { id: options.quotedMessageId } };
    }

    const { data } = await client().post<EvoSentMessage>(
      `/message/sendMedia/${name}`,
      payload
    );

    const providerType = mapEvoType(`${mediaType}Message`);
    return toProviderMessage(data, options?.caption ?? media.filename, true, providerType);
  } catch (err) {
    logger.error({ info: "Evolution sendMedia error", sessionId, to, err });
    throw new AppError("ERR_SENDING_WAPP_MEDIA_MSG");
  }
};

/**
 * Send interactive buttons message.
 * Extra method — only available when using the Evolution provider.
 */
const sendButtons = async (
  sessionId: number,
  to: string,
  buttons: Array<{ id: string; text: string }>,
  text: string
): Promise<void> => {
  const name = instanceName(sessionId);
  const number = to.replace(/@[csg]\.us$/i, "").replace(/@s\.whatsapp\.net$/i, "");

  try {
    await client().post(`/message/sendButtons/${name}`, {
      number,
      title: text,
      description: "",
      footer: "",
      buttons: buttons.map(b => ({ buttonId: b.id, buttonText: { displayText: b.text }, type: 1 }))
    });
  } catch (err) {
    logger.error({ info: "Evolution sendButtons error", sessionId, to, err });
    throw new AppError("ERR_SENDING_WAPP_BUTTONS");
  }
};

/** Delete a message for everyone. */
const deleteMessage = async (
  sessionId: number,
  chatId: string,
  messageId: string,
  _fromMe: boolean
): Promise<void> => {
  const name = instanceName(sessionId);
  const remoteJid = chatId.includes("@") ? chatId : `${chatId}@s.whatsapp.net`;

  try {
    await client().delete(`/chat/deleteMessageForEveryone/${name}`, {
      data: {
        id: messageId,
        remoteJid,
        fromMe: true
      }
    });
  } catch (err) {
    logger.error({ info: "Evolution deleteMessage error", sessionId, chatId, messageId, err });
    throw new AppError("ERR_DELETING_WAPP_MSG");
  }
};

/** Check if a number exists on WhatsApp. Returns the JID string (or throws). */
const checkNumber = async (
  sessionId: number,
  number: string
): Promise<string> => {
  const name = instanceName(sessionId);
  const cleanNumber = number.replace(/\D/g, "");

  try {
    const { data } = await client().post<EvoCheckNumberResult[]>(
      `/chat/whatsappNumbers/${name}`,
      { numbers: [cleanNumber] }
    );

    const result = data?.[0];
    if (!result?.exists) {
      throw new AppError("ERR_NUMBER_NOT_ON_WHATSAPP", 404);
    }

    return result.jid;
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error({ info: "Evolution checkNumber error", sessionId, number, err });
    throw new AppError("ERR_WAPP_CHECK_CONTACT");
  }
};

/** Get profile picture URL. Returns empty string if not available. */
const getProfilePicUrl = async (
  sessionId: number,
  number: string
): Promise<string> => {
  const name = instanceName(sessionId);
  const cleanNumber = number.replace(/\D/g, "");

  try {
    const { data } = await client().get<{ profilePictureUrl?: string }>(
      `/chat/fetchProfilePictureUrl/${name}`,
      { params: { number: cleanNumber } }
    );

    return data?.profilePictureUrl ?? "";
  } catch (err) {
    logger.debug({ info: "Evolution getProfilePicUrl failed (non-critical)", sessionId, number, err });
    return "";
  }
};

/** List all contacts known to the instance. */
const getContacts = async (sessionId: number): Promise<ProviderContact[]> => {
  const name = instanceName(sessionId);

  try {
    const { data } = await client().get<EvoContact[]>(
      `/chat/findContacts/${name}`
    );

    if (!Array.isArray(data)) return [];

    return data.map(c => {
      const raw = c.id.replace(/@s\.whatsapp\.net$/, "").replace(/@g\.us$/, "");
      const isGroup = c.id.endsWith("@g.us");
      return {
        id: c.id,
        number: raw,
        name: c.pushName ?? raw,
        pushname: c.pushName ?? "",
        profilePicUrl: c.profilePictureUrl,
        isGroup
      };
    });
  } catch (err) {
    logger.error({ info: "Evolution getContacts error", sessionId, err });
    return [];
  }
};

/** Mark chat messages as read. */
const sendSeen = async (sessionId: number, chatId: string): Promise<void> => {
  const name = instanceName(sessionId);
  const remoteJid = chatId.includes("@") ? chatId : `${chatId}@s.whatsapp.net`;

  try {
    await client().post(`/chat/markMessageAsRead/${name}`, {
      readMessages: [{ remoteJid, fromMe: false, id: "all" }]
    });
  } catch (err) {
    // Non-critical — log and continue
    logger.debug({ info: "Evolution sendSeen failed (non-critical)", sessionId, chatId, err });
  }
};

/**
 * Fetch recent messages from a chat.
 * Evolution API returns messages in its own format; map to ProviderMessage.
 */
const fetchChatMessages = async (
  sessionId: number,
  chatId: string,
  limit = 100
): Promise<ProviderMessage[]> => {
  const name = instanceName(sessionId);
  const remoteJid = chatId.includes("@") ? chatId : `${chatId}@s.whatsapp.net`;

  try {
    const { data } = await client().post<
      Array<{
        key: { id: string; fromMe: boolean; remoteJid: string };
        message?: Record<string, unknown>;
        messageType?: string;
        messageTimestamp?: number;
        body?: string;
      }>
    >(`/chat/findMessages/${name}`, {
      where: { key: { remoteJid } },
      limit
    });

    if (!Array.isArray(data)) return [];

    const mediaTypes = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"];

    return data.map(m => ({
      id: m.key.id,
      body: String(m.body ?? ""),
      fromMe: m.key.fromMe,
      hasMedia: Boolean(m.messageType && mediaTypes.indexOf(m.messageType) !== -1),
      type: mapEvoType(m.messageType),
      timestamp: m.messageTimestamp ?? Math.floor(Date.now() / 1000),
      from: m.key.remoteJid,
      to: m.key.remoteJid,
      ack: 2
    }));
  } catch (err) {
    logger.error({ info: "Evolution fetchChatMessages error", sessionId, chatId, err });
    return [];
  }
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const EvolutionProvider: WhatsappProvider & {
  sendButtons: typeof sendButtons;
} = {
  init,
  removeSession,
  logout,
  sendMessage,
  sendMedia,
  deleteMessage,
  checkNumber,
  getProfilePicUrl,
  getContacts,
  sendSeen,
  fetchChatMessages,
  // Extra method — only available on Evolution
  sendButtons
};
