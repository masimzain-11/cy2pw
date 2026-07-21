describe('Login', () => {
  beforeEach(() => {
    cy.visit('https://practicesoftwaretesting.com/auth/login')
  })

  it('logs in with valid credentials', () => {
    cy.get('[data-test="email"]').type('customer@practicesoftwaretesting.com')
    cy.get('[data-test="password"]').type('welcome01')
    cy.get('[data-test="login-submit"]').click()
    cy.url().should('include', '/account')
    cy.get('[data-test="nav-menu"]').should('be.visible')
    cy.contains('My account').should('exist')
  })

  it('shows an error for a bad password', () => {
    cy.get('[data-test="email"]').type('customer@practicesoftwaretesting.com')
    cy.get('[data-test="password"]').type('wrongpass')
    cy.get('[data-test="login-submit"]').click()
    cy.wait(1000)
    cy.get('[data-test="login-error"]').should('have.text', 'Invalid email or password')
  })
})
