export type ChatReaction = {emoji:string;count:number;reacted:boolean};
export type ChatAttachment = {id:string;name:string;contentType:string;size:number};
export type ChatReply = {id:string;body:string;sender:{id:string;name:string}};
export type ChatPointer = {createdAt:number;id:string};
export type ChatExtras = {reply?:ChatReply|null;reactions?:ChatReaction[];attachments?:ChatAttachment[]};
