import { BadRequestException, Body, Controller, HttpCode, Param, Post, Query } from '@nestjs/common';
import { AssessmentService } from '../application/assessment.service';
import { RebookingService } from '../application/rebooking.service';

const BOOKING_ID = /^[A-Z0-9]{6}$/;

@Controller('v1/bookings')
export class AssessmentController {
  constructor(private readonly assessments: AssessmentService, private readonly rebooking: RebookingService) {}

  // Evalúa (dry-run por defecto). ?act=true ejecuta solo caso humano + notificación validada.
  @Post(':bookingId/disruption-assessment')
  @HttpCode(200)
  async assess(
    @Param('bookingId') bookingId: string,
    @Query('act') act?: string,
    @Body() body: { compensationRequested?: boolean } = {},
  ) {
    if (!BOOKING_ID.test(bookingId)) throw new BadRequestException('INVALID_BOOKING_ID');
    const assessment = await this.assessments.assess(bookingId, { compensationRequested: body?.compensationRequested === true });
    return act === 'true' ? { assessment, executed: await this.assessments.act(assessment) } : { assessment };
  }

  // Única vía a create_rebooking_request. Solo para reprogramaciones que no requieren aprobación humana.
  @Post(':bookingId/rebooking-confirmations')
  @HttpCode(200)
  async confirm(@Param('bookingId') bookingId: string, @Body() body: { optionId?: string }) {
    if (!BOOKING_ID.test(bookingId) || !body?.optionId) throw new BadRequestException('INVALID_REQUEST');
    return this.rebooking.confirm(bookingId, body.optionId);
  }
}
