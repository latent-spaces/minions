/** Private, informational notices. They never request work or grant permissions. */
export type ModerationNotification = {
  id:string;kind:'agent_moderation';projectId:string;projectTitle:string;agentId:string;agentName:string;
  actorProfileId:string;actorName:string;action:'pause'|'stop'|'end_participation';reason:string;
  createdAt:number;readAt:number|null;
};
export type KarmaNotification = ModerationNotification;
export type NotificationPage = {items:KarmaNotification[];next:string|null};
