export interface Account {
    id: string;
    name: string;
    industry: string;
    employee_count: number;
    arr: number;                     // annual recurring revenue in USD
    segment: 'enterprise' | 'mid_market' | 'smb';
    health_score: number;            // 0-100
    renewal_date: string;            // ISO date
    primary_contact_name: string;
    primary_contact_role: string;
    updated_at: string;
  }