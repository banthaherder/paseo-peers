import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Markdown, ScrollView, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Text, View, type ScrollView as NativeScrollView } from "react-native";
import {
  MAX_MESSAGE_CHARS,
  deliverMessage,
  markPeerRead,
  removePeer,
  sendMessage,
  updateMessage,
  updatePeer,
  type Peer,
  type PeerMessage,
  type PeersState,
} from "../shared/contracts";
import { Button, errorText, inputStyle, timeLabel } from "./kit";
import { AgentPickerModal } from "./modals";

type Navigation = PluginScreenProps["navigation"];

function outboundStatus(message: PeerMessage, peerName: string): string {
  const agent = message.deliveredTo?.agentTitle ? `"${message.deliveredTo.agentTitle}"` : "an agent";
  switch (message.status) {
    case "pending":
      return "Sending…";
    case "sent":
      return "Sent";
    case "read":
      return `Seen by ${peerName}`;
    case "queued":
      return `Queued for ${peerName}'s agent ${agent}`;
    case "delivered":
      return `Delivered to ${peerName}'s agent ${agent}`;
    case "dismissed":
      return `${peerName} dismissed it`;
    case "failed":
      return `Failed: ${message.error ?? "unknown error"}`;
    default:
      return message.status;
  }
}

function MessageBubble(props: {
  theme: PluginTheme;
  message: PeerMessage;
  peerName: string;
  navigation: Navigation;
  onDeliver(message: PeerMessage): void;
}) {
  const { theme, message, peerName } = props;
  const c = theme.colors;
  const toast = useToast();
  const update = useRpc(updateMessage);
  const inbound = message.direction === "in";
  const author = inbound
    ? message.via === "agent"
      ? `${peerName}'s agent${message.agentTitle ? ` "${message.agentTitle}"` : ""}`
      : peerName
    : message.via === "agent"
      ? `Your agent${message.agentTitle ? ` "${message.agentTitle}"` : ""}`
      : "You";
  const needsAction = inbound && (message.status === "unread" || message.status === "read");

  return (
    <View style={{ alignItems: inbound ? "flex-start" : "flex-end" }}>
      <View
        style={{
          maxWidth: "88%",
          backgroundColor: inbound ? c.surface1 : c.surface2,
          borderColor: needsAction ? c.accent : c.border,
          borderWidth: 1,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
          gap: 6,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {message.via === "agent" ? <Icon name="Bot" size={12} color={c.foregroundMuted} /> : null}
          <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{author}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>· {timeLabel(message.sentAt)}</Text>
        </View>
        <Markdown>{message.text}</Markdown>
        {inbound ? (
          <View style={{ gap: 6 }}>
            {message.status === "queued" ? (
              <Text style={{ color: c.statusWarning, fontSize: 12 }}>
                Waiting for "{message.deliveredTo?.agentTitle}" to finish its turn
              </Text>
            ) : null}
            {message.status === "delivered" ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Icon name="CheckCheck" size={13} color={c.statusSuccess} />
                <Text style={{ color: c.statusSuccess, fontSize: 12 }}>Delivered to "{message.deliveredTo?.agentTitle}"</Text>
                {props.navigation?.openAgent && message.deliveredTo?.agentId ? (
                  <Button theme={theme} compact tone="ghost" label="Open" onPress={() => props.navigation!.openAgent({ agentId: message.deliveredTo!.agentId! })} />
                ) : null}
              </View>
            ) : null}
            {message.status === "dismissed" ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Dismissed</Text> : null}
            {message.error ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>{message.error}</Text> : null}
            {needsAction ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                <Button theme={theme} compact tone="primary" icon="Send" label="Deliver to agent…" onPress={() => props.onDeliver(message)} />
                <Button
                  theme={theme}
                  compact
                  icon="Copy"
                  label="Copy"
                  onPress={async () => {
                    await copyText(message.text).catch((e) => toast.error(errorText(e)));
                  }}
                />
                <Button theme={theme} compact tone="ghost" label="Dismiss" onPress={async () => void (await update({ messageId: message.id, action: "dismiss" }))} />
              </View>
            ) : null}
          </View>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-end" }}>
            <Text style={{ color: message.status === "failed" ? c.statusDanger : message.status === "delivered" ? c.statusSuccess : c.foregroundMuted, fontSize: 12 }}>
              {outboundStatus(message, peerName)}
            </Text>
            {message.status === "failed" ? (
              <Button theme={theme} compact label="Retry" onPress={async () => void (await update({ messageId: message.id, action: "retry" }))} />
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}

export function Thread(props: {
  theme: PluginTheme;
  compact: boolean;
  state: PeersState;
  peer: Peer;
  navigation: Navigation;
  onBack?: () => void;
  onRemoved(): void;
}) {
  const { theme, peer, state } = props;
  const c = theme.colors;
  const toast = useToast();
  const send = useRpc(sendMessage);
  const deliver = useRpc(deliverMessage);
  const markRead = useRpc(markPeerRead);
  const savePeer = useRpc(updatePeer);
  const remove = useRpc(removePeer);
  const [draft, setDraft] = useState("");
  const [deliverTarget, setDeliverTarget] = useState<PeerMessage | null>(null);
  const [pickingAuto, setPickingAuto] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const scroll = useRef<NativeScrollView>(null);
  const messages = state.messages.filter((m) => m.peerId === peer.id);

  useEffect(() => {
    if (peer.unread > 0) void markRead({ peerId: peer.id }).catch(() => {});
  }, [peer.id, peer.unread, markRead]);

  useEffect(() => {
    const timer = setTimeout(() => scroll.current?.scrollToEnd({ animated: false }), 30);
    return () => clearTimeout(timer);
  }, [peer.id, messages.length]);

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    try {
      await send({ peerId: peer.id, text });
      setDraft("");
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: props.compact ? 12 : 20,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
          flexWrap: "wrap",
        }}
      >
        {props.onBack ? <Button theme={theme} compact tone="ghost" icon="ChevronLeft" label="Peers" onPress={props.onBack} /> : null}
        <View style={{ flex: 1, minWidth: 120 }}>
          <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>{peer.name}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>Key {peer.fingerprint}</Text>
        </View>
        <Button
          theme={theme}
          compact
          icon={peer.autoDeliverAgentId ? "Zap" : "Hand"}
          label={peer.autoDeliverAgentId ? `Auto → ${peer.autoDeliverAgentTitle ?? "agent"}` : "Approve each message"}
          accessibilityLabel="Change delivery mode"
          onPress={() => setPickingAuto(true)}
        />
        {confirmRemove ? (
          <>
            <Button
              theme={theme}
              compact
              tone="danger"
              label="Remove peer and history"
              onPress={async () => {
                await remove({ peerId: peer.id });
                props.onRemoved();
              }}
            />
            <Button theme={theme} compact tone="ghost" label="Cancel" onPress={() => setConfirmRemove(false)} />
          </>
        ) : (
          <Button theme={theme} compact tone="ghost" icon="Trash2" label="" accessibilityLabel={`Remove ${peer.name}`} onPress={() => setConfirmRemove(true)} />
        )}
      </View>

      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ padding: props.compact ? 12 : 20, gap: 12 }}>
        {messages.length === 0 ? (
          <Text style={{ color: c.foregroundMuted, textAlign: "center", marginTop: 24 }}>
            No messages yet. Anything you send here lands in {peer.name}'s Paseo inbox, and they pick which agent gets it.
          </Text>
        ) : null}
        {messages.map((message) => (
          <MessageBubble key={message.id} theme={theme} message={message} peerName={peer.name} navigation={props.navigation} onDeliver={setDeliverTarget} />
        ))}
      </ScrollView>

      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, padding: props.compact ? 10 : 14, borderTopWidth: 1, borderTopColor: c.border }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={`Context for ${peer.name}'s agents… (Markdown)`}
          placeholderTextColor={c.foregroundMuted}
          multiline
          maxLength={MAX_MESSAGE_CHARS}
          style={[inputStyle(theme, true), { flex: 1, maxHeight: 220 }]}
        />
        <Button theme={theme} tone="primary" icon="Send" label="Send" disabled={!draft.trim()} onPress={submit} />
      </View>

      <AgentPickerModal
        theme={theme}
        open={deliverTarget !== null}
        title={`Deliver ${peer.name}'s message to…`}
        onClose={() => setDeliverTarget(null)}
        onPick={async (agent) => {
          if (!agent || !deliverTarget) return;
          const result = await deliver({ messageId: deliverTarget.id, agentId: agent.id });
          toast.show(result.status === "queued" ? `Queued for "${agent.title}" (it's mid-turn)` : `Delivered to "${agent.title}"`, { variant: "success" });
        }}
      />
      <AgentPickerModal
        theme={theme}
        open={pickingAuto}
        allowNone
        title={`Auto-deliver ${peer.name}'s messages to…`}
        onClose={() => setPickingAuto(false)}
        onPick={async (agent) => {
          await savePeer({ peerId: peer.id, autoDeliverAgentId: agent?.id ?? null });
        }}
      />
    </View>
  );
}
