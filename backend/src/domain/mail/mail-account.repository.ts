import { MailAccountModel, type MailAccountDoc } from './mail-account.model';

/** Data access for linked Google mailboxes. Token-bearing reads are explicit and backend-only. */
export const mailAccountRepository = {
  list(): Promise<MailAccountDoc[]> {
    return MailAccountModel.find().sort({ email: 1 }).exec();
  },

  findById(id: string): Promise<MailAccountDoc | null> {
    return MailAccountModel.findById(id).exec();
  },

  findByIds(ids: string[]): Promise<MailAccountDoc[]> {
    return MailAccountModel.find({ _id: { $in: ids } }).exec();
  },

  /** The only read that surfaces the encrypted refresh token — for the Gmail client, never a route. */
  findByIdWithToken(id: string): Promise<MailAccountDoc | null> {
    return MailAccountModel.findById(id).select('+refresh_token_enc').exec();
  },

  /**
   * Link (or re-link) a mailbox after a successful OAuth exchange. Upserts on the address so
   * re-consenting the same account replaces the token and clears any error state.
   */
  upsertLinked(email: string, refreshTokenEnc: string, scopes: string): Promise<MailAccountDoc | null> {
    return MailAccountModel.findOneAndUpdate(
      { email },
      { email, provider: 'google', refresh_token_enc: refreshTokenEnc, scopes, status: 'linked', last_error: '' },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  },

  /** Flag an account whose token no longer authenticates (shown on Settings → Connections). */
  async markError(id: string, message: string): Promise<void> {
    await MailAccountModel.updateOne({ _id: id }, { status: 'error', last_error: message }).exec();
  },

  delete(id: string): Promise<MailAccountDoc | null> {
    return MailAccountModel.findByIdAndDelete(id).exec();
  },
};
