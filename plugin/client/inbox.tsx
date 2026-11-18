import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Loading, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { configure, type PeersState } from "../shared/contracts";
import { Badge, Button, Card, Label, StatusDot, errorText, inputStyle, relayStatusLabel, timeLabel, usePeers } from "./kit";
import { InviteModal, JoinModal } from "./modals";
import { Thread } from "./thread";

export function SetupForm({ theme, state, onJoin }: { theme: PluginTheme; state: PeersState; onJoin(): void }) {
  const c = theme.colors;
  const save = useRpc(configure);
  const [name, setName] = useState(state.profile.name);
  const [relayUrl, setRelayUrl] = useState(state.relay.url ?? "");
  const [adminToken, setAdminToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <View style={{ gap: 16, width: "100%", maxWidth: 560, alignSelf: "center" }}>
      <View style={{ gap: 6 }}>
        <Text style={{ color: c.foreground, fontSize: 22, fontWeight: "700" }}>Paseo Peers</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 14 }}>
          Send context straight to a trusted friend's Paseo. Messages are end-to-end encrypted, pass through a relay you host, and land in their inbox
          for them to hand to an agent.
        </Text>
      </View>

      <Card theme={theme}>
        <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "600" }}>Got an invite code?</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Paste it to pair. It already has the relay address, so there's nothing else to set up.</Text>
        <View style={{ flexDirection: "row" }}>
          <Button theme={theme} tone="primary" icon="Link" label="Join with invite code" onPress={onJoin} />
        </View>
      </Card>

      <Card theme={theme}>
        <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "600" }}>Running the relay yourself?</Text>
        <Label theme={theme}>Your name, as peers see it</Label>
        <TextInput value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={c.foregroundMuted} style={inputStyle(theme)} />
        <Label theme={theme}>Relay URL</Label>
        <TextInput
          value={relayUrl}
          onChangeText={setRelayUrl}
          placeholder="https://relay.example.com"
          placeholderTextColor={c.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={inputStyle(theme)}
        />
        <Label theme={theme}>Relay admin token (lets this install create invites)</Label>
        <TextInput
          value={adminToken}
          onChangeText={setAdminToken}
          placeholder={state.relay.hasAdminToken ? "Saved. Leave blank to keep it." : "RELAY_ADMIN_TOKEN from the relay's env"}
          placeholderTextColor={c.foregroundMuted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={inputStyle(theme)}
        />
        {error ? <Text style={{ color: c.statusDanger }}>{error}</Text> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <Button
            theme={theme}
            tone="primary"
            label="Save"
            disabled={!name.trim() || !relayUrl.trim()}
            onPress={async () => {
              setError(null);
              try {
                await save({ name: name.trim(), relayUrl: relayUrl.trim(), ...(adminToken.trim() ? { adminToken: adminToken.trim() } : {}) });
                setAdminToken("");
              } catch (e) {
                setError(errorText(e));
              }
            }}
          />
        </View>
      </Card>
    </View>
  );
}

function PeerList(props: {
  theme: PluginTheme;
  state: PeersState;
  selectedId: string | null;
  onSelect(id: string): void;
  onInvite(): void;
  onJoin(): void;
}) {
  const { theme, state } = props;
  const c = theme.colors;
  const lastText = (peerId: string) => state.messages.filter((m) => m.peerId === peerId).at(-1);

  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {state.relay.hasAdminToken ? <Button theme={theme} compact icon="UserPlus" label="Invite" onPress={props.onInvite} /> : null}
        <Button theme={theme} compact icon="Link" label="Join" onPress={props.onJoin} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 4 }}>
        {state.peers.length === 0 ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 13, paddingVertical: 8 }}>
            {state.relay.hasAdminToken
              ? "No peers yet. Invite someone: they install Paseo Peers and paste your code."
              : "No peers yet. Ask the relay owner for an invite code, then Join."}
          </Text>
        ) : null}
        {state.peers.map((peer) => {
          const last = lastText(peer.id);
          const active = peer.id === props.selectedId;
          return (
            <Pressable
              key={peer.id}
              accessibilityRole="button"
              accessibilityLabel={`${peer.name}${peer.unread ? `, ${peer.unread} unread` : ""}`}
              onPress={() => props.onSelect(peer.id)}
              style={({ pressed }) => ({
                padding: 10,
                borderRadius: 10,
                gap: 3,
                backgroundColor: active ? c.surface2 : pressed ? c.surface1 : "transparent",
              })}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: c.foreground, fontSize: 14, fontWeight: peer.unread ? "700" : "500", flex: 1 }} numberOfLines={1}>
                  {peer.name}
                </Text>
                {peer.autoDeliverAgentId ? <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>auto</Text> : null}
                <Badge theme={theme} count={peer.unread} />
              </View>
              {last ? (
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
                  {last.direction === "out" ? "You: " : ""}
                  {last.text.replace(/\s+/g, " ")} · {timeLabel(last.sentAt)}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 6 }}>
        <StatusDot theme={theme} status={state.relay.status} />
        <Text style={{ color: c.foregroundMuted, fontSize: 11, flex: 1 }} numberOfLines={2}>
          {relayStatusLabel[state.relay.status]}
          {state.relay.status !== "online" && state.relay.lastError ? `: ${state.relay.lastError}` : ""}
        </Text>
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
        You are {state.profile.name} · key {state.identity.fingerprint}
      </Text>
    </View>
  );
}

export function InboxScreen({ theme, layout, params, navigation }: PluginScreenProps) {
  const c = theme.colors;
  const { state, error } = usePeers();
  const [selectedId, setSelectedId] = useState<string | null>(params.peerId ?? null);
  const [inviting, setInviting] = useState(false);
  const [joining, setJoining] = useState(false);

  if (error) {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: c.surface0 }}>
        <Text style={{ color: c.statusDanger }}>{error}</Text>
      </View>
    );
  }
  if (!state) return <Loading />;

  const modals = (
    <>
      <InviteModal theme={theme} open={inviting} onClose={() => setInviting(false)} />
      <JoinModal theme={theme} open={joining} defaultName={state.profile.name} onClose={() => setJoining(false)} onJoined={setSelectedId} />
    </>
  );

  if (!state.configured && state.peers.length === 0) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 32 }}>
        <SetupForm theme={theme} state={state} onJoin={() => setJoining(true)} />
        {modals}
      </ScrollView>
    );
  }

  const selected = state.peers.find((p) => p.id === selectedId) ?? (layout.compact ? null : (state.peers[0] ?? null));
  const list = (
    <PeerList
      theme={theme}
      state={state}
      selectedId={selected?.id ?? null}
      onSelect={setSelectedId}
      onInvite={() => setInviting(true)}
      onJoin={() => setJoining(true)}
    />
  );
  const thread = selected ? (
    <Thread
      theme={theme}
      compact={layout.compact}
      state={state}
      peer={selected}
      navigation={navigation}
      onBack={layout.compact ? () => setSelectedId(null) : undefined}
      onRemoved={() => setSelectedId(null)}
    />
  ) : (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Text style={{ color: c.foregroundMuted }}>Pick a peer, or invite one.</Text>
    </View>
  );

  if (layout.compact) {
    return (
      <View style={{ flex: 1, backgroundColor: c.surface0 }}>
        {selected ? thread : <View style={{ flex: 1, padding: 12 }}>{list}</View>}
        {modals}
      </View>
    );
  }
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: c.surface0 }}>
      <View style={{ width: 280, padding: 14, borderRightWidth: 1, borderRightColor: c.border }}>{list}</View>
      {thread}
      {modals}
    </View>
  );
}
