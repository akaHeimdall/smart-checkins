import { graphGet } from "../graph";
import { createChildLogger } from "../logger";
import type { EmailMessage } from "../types";

const log = createChildLogger("collector-mail");

interface GraphMailResponse {
  value: Array<{
    id: string;
    conversationId: string;
    subject: string;
    from: {
      emailAddress: {
        name: string;
        address: string;
      };
    };
    receivedDateTime: string;
    bodyPreview: string;
    isRead: boolean;
  }>;
}

// ── Fetch unread emails from last 7 days ──────────────────────────

export async function fetchUnreadEmails(): Promise<EmailMessage[]> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const filterDate = sevenDaysAgo.toISOString();

  try {
    const response = await graphGet<GraphMailResponse>(
      "/mailFolders/inbox/messages",
      {
        $filter: `isRead eq false and receivedDateTime ge ${filterDate}`,
        $select: "id,conversationId,subject,from,receivedDateTime,bodyPreview,isRead",
        $orderby: "receivedDateTime desc",
        $top: "50",
      }
    );

    const emails: EmailMessage[] = response.value.map((msg) => ({
      id: msg.id,
      conversationId: msg.conversationId,
      subject: msg.subject,
      from: {
        name: msg.from.emailAddress.name,
        address: msg.from.emailAddress.address,
      },
      receivedDateTime: msg.receivedDateTime,
      bodyPreview: msg.bodyPreview,
      isRead: msg.isRead,
    }));

    log.info({ count: emails.length }, "Fetched unread emails");
    return emails;
  } catch (error) {
    log.error({ error }, "Failed to fetch unread emails");
    throw error;
  }
}

// ── Check if a specific conversation has a reply in Sent folder ───

export async function checkSentReply(conversationId: string): Promise<boolean> {
  try {
    const response = await graphGet<GraphMailResponse>(
      "/mailFolders/sentItems/messages",
      {
        $filter: `conversationId eq '${conversationId}'`,
        $top: "1",
        $select: "id",
      }
    );

    return response.value.length > 0;
  } catch (error) {
    log.warn({ conversationId, error }, "Failed to check sent reply — assuming no reply");
    return false;
  }
}
