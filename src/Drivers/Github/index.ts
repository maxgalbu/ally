/*
 * @adonisjs/ally
 *
 * (c) Harminder Virk <virk@adonisjs.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/// <reference path="../../../adonis-typings/index.ts" />

import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import {
	GithubToken,
	AllyUserContract,
	GithubDriverConfig,
	GithubDriverContract,
	OauthUserRequestContract,
} from '@ioc:Adonis/Addons/Ally'

import { github } from '../../Config'
import { HttpClient } from '../../HttpClient'
import { StateManager } from '../../StateManager'
import { GithubRedirectRequest } from './Request'
import { OauthException } from '../../Exceptions'
import { Oauth2Request } from '../../Spec/Oauth2Request'

/**
 * Github driver to interact with the Github APIs for connecting
 * user accounts
 */
export class GithubDriver implements GithubDriverContract {
	private isStateless: boolean = false
	private stateManager = new StateManager('gh_oauth_state', 'state', this.ctx)

	constructor(private config: GithubDriverConfig, private ctx: HttpContextContract) {}

	/**
	 * Instantiate the redirect request
	 */
	protected buildRedirectRequest(callback?: (request: GithubRedirectRequest) => void) {
		const redirectRequest = new GithubRedirectRequest(this.config)
		if (typeof callback === 'function') {
			callback(redirectRequest)
		}

		return redirectRequest
	}

	/**
	 * Mark authorization flow as stateless
	 */
	public stateless() {
		this.isStateless = true
		return this
	}

	/**
	 * Redirects the user to github for authorizing the request
	 */
	public redirect(callback?: (request: GithubRedirectRequest) => void): void {
		const redirectRequest = this.buildRedirectRequest(callback)

		/**
		 * Set state when not disabled
		 */
		if (!this.isStateless) {
			const state = this.stateManager.setState()
			redirectRequest.param('state', state)
		}

		this.ctx.response.redirect(redirectRequest.toString())
	}

	/**
	 * Makes the redirect url for authorizing
	 */
	public getRedirectUrl(callback?: (request: GithubRedirectRequest) => void): string {
		return this.buildRedirectRequest(callback).toString()
	}

	/**
	 * Find if the redirect request has the authorization code
	 */
	public hasCode(): boolean {
		return !!this.ctx.request.input('code')
	}

	/**
	 * Find if the access was denied
	 */
	public accessDenied(): boolean {
		return this.getError() === 'access_denied'
	}

	/**
	 * Find if state is invalid. This will happen in one of the following cases
	 *
	 * - Cookies are not supported
	 * - Cookie has been expired
	 * - Cookie is unaccessible coz of URL mis-match
	 */
	public stateMisMatch(): boolean {
		if (this.isStateless) {
			return false
		}

		return this.stateManager.stateMisMatch()
	}

	/**
	 * Find if the redirect request has errors
	 */
	public hasError(): boolean {
		return !!this.getError()
	}

	/**
	 * Get the redirect error
	 */
	public getError(): string | null {
		const error = this.ctx.request.input('error')
		if (error) {
			return error
		}

		if (!this.ctx.request.input('code')) {
			return 'unknown_error'
		}

		return null
	}

	/**
	 * Returns the access token by exchanging the authorization code. The
	 * method must be called right after the redirect
	 */
	public async getAccessToken(): Promise<GithubToken> {
		if (this.hasError()) {
			throw OauthException.missingAuthorizationCode()
		}

		/**
		 * Raise exception if state has mismatch
		 */
		if (this.stateMisMatch()) {
			throw OauthException.stateMisMatch()
		}

		const accessToken = await new Oauth2Request(
			this.config.accessTokenUrl || github.ACCESS_TOKEN_URL,
			{
				clientId: this.config.clientId,
				clientSecret: this.config.clientSecret,
				redirectUri: this.config.callbackUrl,
				code: this.ctx.request.input('code'),
			}
		).getAccessToken()

		/**
		 * Map the oauth2 response to an object with known
		 * properties
		 */
		return {
			value: accessToken.accessToken,
			grantedScopes: accessToken.scope.split(' '),
		}
	}

	/**
	 * Fetch the user along with the access token
	 */
	public async getUser(
		callback?: (request: OauthUserRequestContract) => void
	): Promise<AllyUserContract<GithubToken>> {
		const accessToken = await this.getAccessToken()

		const user = await this.getUserForToken(accessToken.value, callback)
		user.token = accessToken

		return (user as unknown) as Promise<AllyUserContract<GithubToken>>
	}

	/**
	 * Fetch the user for a pre-existing access token
	 */
	public async getUserForToken(
		token: string,
		callback?: (request: OauthUserRequestContract) => void
	): Promise<AllyUserContract<{ value: string }>> {
		/**
		 * Configure the user info request. One can configure it using
		 * the callback
		 */
		const request = new HttpClient(this.config.userInfoUrl || github.USER_INFO_URL)
		request.header('Authorization', `token ${token}`)
		request.header('Accept', 'application/json')
		request.parseResponseAs('json')
		if (typeof callback === 'function') {
			callback(request)
		}

		/**
		 * Github user
		 */
		const body = await request.get()

		/**
		 * Get user emails
		 */
		const emailRequest = new HttpClient(github.USER_EMAIL_URL)
		emailRequest.header('Authorization', `token ${token}`)
		emailRequest.header('Accept', 'application/json')
		emailRequest.parseResponseAs('json')
		const emails = await emailRequest.get()

		/**
		 * Sort emails to keep the primary ones on the top
		 */
		body.emails = emails.sort((email: any) => (email.primary ? -1 : 1))

		/**
		 * Get the first verified email of the user
		 */
		let mainEmail = body.emails.find((email: any) => email.verified)

		/**
		 * If there are no verified emails, then get any first one
		 */
		if (!mainEmail) {
			mainEmail = emails[0]
		}

		return {
			id: body.id,
			nickName: body.name,
			name: body.name,
			email: mainEmail.email,
			avatarUrl: body.avatar_url,
			emailVerificationState: mainEmail.verified ? 'verified' : 'unverified',
			token: { value: token },
			original: body,
		}
	}

	/**
	 * Not allowed, the method is specific to oauth 1.0
	 */
	public async getUserForTokenAndSecret(
		_: string,
		__: string,
		___?: (request: OauthUserRequestContract) => void
	): Promise<never> {
		throw new Error(
			'Cannot use "getUserForTokenAndSecret" method on google driver. Use "getUserForToken" method instead'
		)
	}
}
