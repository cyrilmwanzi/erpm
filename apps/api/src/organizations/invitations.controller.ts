import { Controller, Inject, Param, Post, Req } from "@nestjs/common";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import type { FastifyRequest } from "fastify";
import { OrganizationsService } from "./organizations.service.js";

@Controller("api/v1/organizations/invitations")
export class InvitationsController {
  constructor(
    @Inject(OrganizationsService)
    private readonly organizationsService: OrganizationsService,
  ) {}

  @Post(":invitationId/accept")
  async acceptInvitation(
    @Param("invitationId") invitationId: string,
    @Session() userSession: UserSession,
    @Req() req: FastifyRequest,
  ) {
    return this.organizationsService.acceptInvitation(
      invitationId,
      userSession.user.emailVerified,
      req.headers,
    );
  }
}
