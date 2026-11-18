import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { InboxScreen } from "./client/inbox";
import { Badge, StatusDot, usePeers } from "./client/kit";
import { SettingsScreen } from "./client/settings";
import { sendToPeerByName } from "./shared/contracts";

function PeersItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { state } = usePeers();
  const unread = state?.unreadTotal ?? 0;
  const troubled = state?.configured && (state.relay.status === "offline" || state.relay.status === "unregistered");
  return (
    <SidebarRow
      icon="MessagesSquare"
      label={unread ? `Peers (${unread})` : "Peers"}
      active={currentScreen?.screenId === "inbox"}
      onPress={() => openScreen({ screenId: "inbox" })}
      trailing={
        unread || troubled ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 8 }}>
            {troubled && state ? <StatusDot theme={theme} status={state.relay.status} /> : null}
            <Badge theme={theme} count={unread} />
          </View>
        ) : undefined
      }
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "inbox", title: "Peers", Component: InboxScreen });
  client.addSidebarHeaderItem({ id: "peers", title: "Peers", Component: PeersItem });
  client.addSettingsScreen({ id: "settings", title: "Peers", icon: "MessagesSquare", Component: SettingsScreen });
  client.addCommandCenterItem({
    id: "open-inbox",
    title: "Open Peers inbox",
    icon: "MessagesSquare",
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "inbox" });
    },
  });
  client.addSlashCommand({
    name: "peer",
    description: "Send context to a paired peer. With no message, forwards this agent's latest reply.",
    argumentHint: "<peer name> [message]",
    context: "agent",
    async onSubmit({ args, agent, rpc }) {
      if (!args.trim()) throw new Error("Usage: /peer <peer name> [message]");
      await rpc(sendToPeerByName, { args, agentId: agent.id });
    },
  });
  return () => {};
}
