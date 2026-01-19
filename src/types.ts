import { type PublicEventMessageCreate } from "alemonjs";
export interface EventMessageCreate extends PublicEventMessageCreate {
  msg: string;
  user_id: string;
}
